import { useQuery, useQueryClient } from "@tanstack/react-query";

export type Scope = "read" | "write" | "admin";
export interface Session {
  /** Sent with every API request; the server only lets browser requests write when it matches. */
  csrf: string;
  /** "none": a local server without sign-in; "token": a server that needs API tokens. */
  auth: "none" | "token";
  publicRead: boolean;
  version: string;
  principal: { name: string; scope: Scope } | null;
}

const ORDER: Scope[] = ["read", "write", "admin"];
export const allows = (session: Session | undefined, needed: Scope) =>
  !!session?.principal && ORDER.indexOf(session.principal.scope) >= ORDER.indexOf(needed);

let current: Promise<Session> | null = null;

async function call(init?: RequestInit): Promise<Session> {
  const response = await fetch("/api/session", { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await response.json().catch(() => null)) as (Session & { error?: { message: string } }) | null;
  if (!response.ok || !body) throw new Error(body?.error?.message ?? `Could not start a session (HTTP ${response.status}).`);
  return body;
}

/** The current session, fetched once per page load (and again after signing in or out). */
export function loadSession(): Promise<Session> {
  current ??= call().catch((error) => {
    current = null;
    throw error;
  });
  return current;
}

export const SESSION_KEY = ["session"];

export function forgetSession() {
  current = null;
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: loadSession, staleTime: Infinity, retry: 1 });
}

/** Sign in/out and refresh everything that depends on who is asking. */
export function useSessionActions() {
  const client = useQueryClient();
  const reset = async (next: Promise<Session>) => {
    const session = await next;
    current = Promise.resolve(session);
    client.setQueryData(SESSION_KEY, session);
    await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
    return session;
  };
  return {
    signIn: (token: string) => reset(call({ method: "POST", body: JSON.stringify({ token }) })),
    signOut: () => reset(call({ method: "DELETE" })),
  };
}
