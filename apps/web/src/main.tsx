import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { App } from "./App.tsx";
import { AuthenticationError } from "@/lib/graphql";
import { forgetSession, SESSION_KEY } from "@/lib/session";
import "./index.css";

const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: (count, error) => !(error instanceof AuthenticationError) && count < 1 } },
  // A revoked or expired session: ask the server again, which shows the sign-in page.
  queryCache: new QueryCache({
    onError: (error) => {
      if (!(error instanceof AuthenticationError)) return;
      forgetSession();
      void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    },
  }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={150}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
