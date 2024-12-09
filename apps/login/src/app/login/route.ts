import { getAllSessions } from "@/lib/cookies";
import { idpTypeToSlug } from "@/lib/idp";
import { sendLoginname } from "@/lib/server/loginname";
import {
  createCallback,
  getActiveIdentityProviders,
  getAuthRequest,
  getOrgsByDomain,
  listSessions,
  startIdentityProviderFlow,
} from "@/lib/zitadel";
import { create, timestampDate } from "@zitadel/client";
import {
  AuthRequest,
  Prompt,
} from "@zitadel/proto/zitadel/oidc/v2/authorization_pb";
import {
  CreateCallbackRequestSchema,
  SessionSchema,
} from "@zitadel/proto/zitadel/oidc/v2/oidc_service_pb";
import { Session } from "@zitadel/proto/zitadel/session/v2/session_pb";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = false;
export const fetchCache = "default-no-store";

async function loadSessions(ids: string[]): Promise<Session[]> {
  const response = await listSessions(
    ids.filter((id: string | undefined) => !!id),
  );

  return response?.sessions ?? [];
}

const ORG_SCOPE_REGEX = /urn:zitadel:iam:org:id:([0-9]+)/;
const ORG_DOMAIN_SCOPE_REGEX = /urn:zitadel:iam:org:domain:primary:(.+)/; // TODO: check regex for all domain character options
const IDP_SCOPE_REGEX = /urn:zitadel:iam:org:idp:id:(.+)/;

function isSessionValid(session: Session): boolean {
  const validPassword = session?.factors?.password?.verifiedAt;
  const validPasskey = session?.factors?.webAuthN?.verifiedAt;
  const validIDP = session?.factors?.intent?.verifiedAt;

  const stillValid = session.expirationDate
    ? timestampDate(session.expirationDate) > new Date()
    : true;

  const validFactors = !!(
    (validPassword || validPasskey || validIDP) &&
    stillValid
  );

  return stillValid && validFactors;
}

function findValidSession(
  sessions: Session[],
  authRequest: AuthRequest,
): Session | undefined {
  const validSessionsWithHint = sessions
    .filter((s) => {
      if (authRequest.hintUserId) {
        return s.factors?.user?.id === authRequest.hintUserId;
      }
      if (authRequest.loginHint) {
        return s.factors?.user?.loginName === authRequest.loginHint;
      }
      return false;
    })
    .filter(isSessionValid);

  if (validSessionsWithHint.length === 0) {
    return undefined;
  }

  validSessionsWithHint.sort((a, b) => {
    const dateA = a.changeDate ? timestampDate(a.changeDate).getTime() : 0;
    const dateB = b.changeDate ? timestampDate(b.changeDate).getTime() : 0;
    return dateB - dateA;
  });

  // return most recently changed session
  return sessions[0];
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const authRequestId = searchParams.get("authRequest");
  const sessionId = searchParams.get("sessionId");

  // TODO: find a better way to handle _rsc (react server components) requests and block them to avoid conflicts when creating oidc callback
  const _rsc = searchParams.get("_rsc");
  if (_rsc) {
    return NextResponse.json({ error: "No _rsc supported" }, { status: 500 });
  }

  const sessionCookies = await getAllSessions();
  const ids = sessionCookies.map((s) => s.id);
  let sessions: Session[] = [];
  if (ids && ids.length) {
    sessions = await loadSessions(ids);
  }

  /**
   * TODO: before automatically redirecting to the callbackUrl, check if the session is still valid
   * possible scenaio:
   * mfa is required, session is not valid anymore (e.g. session expired, user logged out, etc.)
   * to check for mfa for automatically selected session -> const response = await listAuthenticationMethodTypes(userId);
   **/

  if (authRequestId && sessionId) {
    console.log(
      `Login with session: ${sessionId} and authRequest: ${authRequestId}`,
    );

    let selectedSession = sessions.find((s) => s.id === sessionId);

    if (selectedSession && selectedSession.id) {
      console.log(`Found session ${selectedSession.id}`);
      const cookie = sessionCookies.find(
        (cookie) => cookie.id === selectedSession?.id,
      );

      if (cookie && cookie.id && cookie.token) {
        const session = {
          sessionId: cookie?.id,
          sessionToken: cookie?.token,
        };

        // works not with _rsc request
        try {
          const { callbackUrl } = await createCallback(
            create(CreateCallbackRequestSchema, {
              authRequestId,
              callbackKind: {
                case: "session",
                value: create(SessionSchema, session),
              },
            }),
          );
          if (callbackUrl) {
            return NextResponse.redirect(callbackUrl);
          } else {
            return NextResponse.json(
              { error: "An error occurred!" },
              { status: 500 },
            );
          }
        } catch (error) {
          return NextResponse.json({ error }, { status: 500 });
        }
      }
    }
  }

  if (authRequestId) {
    const { authRequest } = await getAuthRequest({ authRequestId });

    let organization = "";
    let idpId = "";

    if (authRequest?.scope) {
      const orgScope = authRequest.scope.find((s: string) =>
        ORG_SCOPE_REGEX.test(s),
      );

      const idpScope = authRequest.scope.find((s: string) =>
        IDP_SCOPE_REGEX.test(s),
      );

      if (orgScope) {
        const matched = ORG_SCOPE_REGEX.exec(orgScope);
        organization = matched?.[1] ?? "";
      } else {
        const orgDomainScope = authRequest.scope.find((s: string) =>
          ORG_DOMAIN_SCOPE_REGEX.test(s),
        );

        if (orgDomainScope) {
          const matched = ORG_DOMAIN_SCOPE_REGEX.exec(orgDomainScope);
          const orgDomain = matched?.[1] ?? "";
          if (orgDomain) {
            const orgs = await getOrgsByDomain(orgDomain);
            if (orgs.result && orgs.result.length === 1) {
              organization = orgs.result[0].id ?? "";
            }
          }
        }
      }

      if (idpScope) {
        const matched = IDP_SCOPE_REGEX.exec(idpScope);
        idpId = matched?.[1] ?? "";

        const identityProviders = await getActiveIdentityProviders(
          organization ? organization : undefined,
        ).then((resp) => {
          return resp.identityProviders;
        });

        const idp = identityProviders.find((idp) => idp.id === idpId);

        if (idp) {
          const origin = request.nextUrl.origin;

          const identityProviderType = identityProviders[0].type;
          let provider = idpTypeToSlug(identityProviderType);

          const params = new URLSearchParams();

          if (authRequestId) {
            params.set("authRequestId", authRequestId);
          }

          if (organization) {
            params.set("organization", organization);
          }

          return startIdentityProviderFlow({
            idpId,
            urls: {
              successUrl:
                `${origin}/idp/${provider}/success?` +
                new URLSearchParams(params),
              failureUrl:
                `${origin}/idp/${provider}/failure?` +
                new URLSearchParams(params),
            },
          }).then((resp) => {
            if (
              resp.nextStep.value &&
              typeof resp.nextStep.value === "string"
            ) {
              return NextResponse.redirect(resp.nextStep.value);
            }
          });
        }
      }
    }

    const gotoAccounts = (): NextResponse<unknown> => {
      const accountsUrl = new URL("/accounts", request.url);
      if (authRequest?.id) {
        accountsUrl.searchParams.set("authRequestId", authRequest?.id);
      }
      if (organization) {
        accountsUrl.searchParams.set("organization", organization);
      }

      return NextResponse.redirect(accountsUrl);
    };

    if (authRequest && authRequest.prompt.includes(Prompt.CREATE)) {
      const registerUrl = new URL("/register", request.url);
      if (authRequest.id) {
        registerUrl.searchParams.set("authRequestId", authRequest.id);
      }
      if (organization) {
        registerUrl.searchParams.set("organization", organization);
      }

      return NextResponse.redirect(registerUrl);
    }

    // use existing session and hydrate it for oidc
    if (authRequest && sessions.length) {
      // if some accounts are available for selection and select_account is set
      if (authRequest.prompt.includes(Prompt.SELECT_ACCOUNT)) {
        return gotoAccounts();
      } else if (authRequest.prompt.includes(Prompt.LOGIN)) {
        // if a hint is provided, skip loginname page and jump to the next page
        if (authRequest.loginHint) {
          try {
            const res = await sendLoginname({
              loginName: authRequest.loginHint,
              organization,
              authRequestId: authRequest.id,
            });

            if (res?.redirect) {
              return NextResponse.redirect(res.redirect);
            }
          } catch (error) {
            console.error("Failed to execute sendLoginname:", error);
          }
        }

        const loginNameUrl = new URL("/loginname", request.url);
        if (authRequest.id) {
          loginNameUrl.searchParams.set("authRequestId", authRequest.id);
        }
        if (authRequest.loginHint) {
          loginNameUrl.searchParams.set("loginName", authRequest.loginHint);
        }
        if (organization) {
          loginNameUrl.searchParams.set("organization", organization);
        }
        return NextResponse.redirect(loginNameUrl);
      } else if (authRequest.prompt.includes(Prompt.NONE)) {
        // NONE prompt - silent authentication
        const selectedSession = findValidSession(sessions, authRequest);

        if (!selectedSession || !selectedSession.id) {
          return NextResponse.json(
            { error: "No active session found" },
            { status: 400 },
          );
        }

        const cookie = sessionCookies.find(
          (cookie) => cookie.id === selectedSession.id,
        );

        if (!cookie || !cookie.id || !cookie.token) {
          return NextResponse.json(
            { error: "No active session found" },
            { status: 400 },
          );
        }

        const session = {
          sessionId: cookie.id,
          sessionToken: cookie.token,
        };

        const { callbackUrl } = await createCallback(
          create(CreateCallbackRequestSchema, {
            authRequestId,
            callbackKind: {
              case: "session",
              value: create(SessionSchema, session),
            },
          }),
        );
        return NextResponse.redirect(callbackUrl);
      } else {
        // check for loginHint, userId hint and valid sessions
        let selectedSession = findValidSession(sessions, authRequest);

        if (!selectedSession || !selectedSession.id) {
          return gotoAccounts();
        }

        const cookie = sessionCookies.find(
          (cookie) => cookie.id === selectedSession.id,
        );

        if (!cookie || !cookie.id || !cookie.token) {
          return gotoAccounts();
        }

        const session = {
          sessionId: cookie.id,
          sessionToken: cookie.token,
        };

        try {
          const { callbackUrl } = await createCallback(
            create(CreateCallbackRequestSchema, {
              authRequestId,
              callbackKind: {
                case: "session",
                value: create(SessionSchema, session),
              },
            }),
          );
          if (callbackUrl) {
            return NextResponse.redirect(callbackUrl);
          } else {
            console.log(
              "could not create callback, redirect user to choose other account",
            );
            return gotoAccounts();
          }
        } catch (error) {
          console.error(error);
          return gotoAccounts();
        }
      }
    } else {
      const loginNameUrl = new URL("/loginname", request.url);

      loginNameUrl.searchParams.set("authRequestId", authRequestId);
      if (authRequest?.loginHint) {
        loginNameUrl.searchParams.set("loginName", authRequest.loginHint);
        loginNameUrl.searchParams.set("submit", "true"); // autosubmit
      }

      if (organization) {
        loginNameUrl.searchParams.set("organization", organization);
      }

      return NextResponse.redirect(loginNameUrl);
    }
  } else {
    return NextResponse.json(
      { error: "No authRequestId provided" },
      { status: 500 },
    );
  }
}
