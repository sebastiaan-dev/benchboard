import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { TypedDocumentString } from "@/gql/graphql";

export class GraphQLRequestError extends Error {
  readonly errors: { message: string; path?: (string | number)[] }[];
  constructor(errors: { message: string; path?: (string | number)[] }[]) {
    super(errors.map((error) => error.message).join("\n"));
    this.errors = errors;
  }
}

let session: Promise<string> | null = null;

/** The server's per-process token authorizes mutations; it is only readable same-origin. */
function sessionToken(): Promise<string> {
  session ??= fetch("/api/session").then(async (response) => {
    if (!response.ok) throw new Error(`Could not start a session (HTTP ${response.status}).`);
    return ((await response.json()) as { token: string }).token;
  }).catch((error) => {
    session = null;
    throw error;
  });
  return session;
}

export async function request<TResult, TVariables>(
  document: TypedDocumentString<TResult, TVariables>,
  variables?: TVariables,
): Promise<TResult> {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/graphql-response+json, application/json",
      "x-benchboard-token": await sessionToken(),
    },
    body: JSON.stringify({ query: document.toString(), variables }),
  });
  const body = (await response.json().catch(() => null)) as { data?: TResult; errors?: { message: string }[] } | null;
  if (!body) throw new Error(`GraphQL request failed with HTTP ${response.status}.`);
  if (body.errors?.length) throw new GraphQLRequestError(body.errors);
  if (!body.data) throw new Error("GraphQL response contained no data.");
  return body.data;
}

/** Typed query hook; the operation name and variables form the cache key. */
export function useGraphQL<TResult, TVariables extends Record<string, unknown>>(
  document: TypedDocumentString<TResult, TVariables>,
  variables: TVariables,
  options: Omit<UseQueryOptions<TResult>, "queryKey" | "queryFn"> = {},
) {
  return useQuery<TResult>({
    queryKey: [document.toString(), variables],
    queryFn: () => request(document, variables),
    ...options,
  });
}

export function useGraphQLMutation<TResult, TVariables extends Record<string, unknown>>(
  document: TypedDocumentString<TResult, TVariables>,
) {
  const client = useQueryClient();
  return useMutation<TResult, Error, TVariables>({
    mutationFn: (variables) => request(document, variables),
    onSuccess: () => client.invalidateQueries(),
  });
}
