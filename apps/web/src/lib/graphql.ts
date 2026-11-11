import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { TypedDocumentString } from "@/gql/graphql";
import { loadSession } from "@/lib/session";

export class GraphQLRequestError extends Error {
  readonly errors: { message: string; path?: (string | number)[] }[];
  constructor(errors: { message: string; path?: (string | number)[] }[]) {
    super(errors.map((error) => error.message).join("\n"));
    this.errors = errors;
  }
}

/** The server needs credentials this browser does not have (signed out, or a revoked token). */
export class AuthenticationError extends Error {}

export async function request<TResult, TVariables>(
  document: TypedDocumentString<TResult, TVariables>,
  variables?: TVariables,
): Promise<TResult> {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/graphql-response+json, application/json",
      "x-benchboard-csrf": (await loadSession()).csrf,
    },
    body: JSON.stringify({ query: document.toString(), variables }),
  });
  if (response.status === 401) throw new AuthenticationError("Sign in to see this server's benchmarks.");
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
