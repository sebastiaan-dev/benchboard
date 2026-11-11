import { useState } from "react";
import { useNavigate } from "react-router";
import { Activity, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Command } from "@/components/kit/onboarding";
import { useSessionActions } from "@/lib/session";

/** Token sign-in for servers that require authentication. The token ends up in an HttpOnly cookie. */
export function SignInPage({ redirect = false }: { redirect?: boolean }) {
  const { signIn } = useSessionActions();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn(token.trim());
      if (redirect) navigate("/", { replace: true });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="bg-background flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="bg-foreground text-background flex size-10 items-center justify-center rounded-xl"><Activity className="size-5" /></span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in to Benchboard</h1>
            <p className="text-muted-foreground text-sm">{window.location.host} needs an API token.</p>
          </div>
        </div>
        <form onSubmit={submit} className="bg-card space-y-4 rounded-xl border p-5 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="token">API token</Label>
            <Input id="token" type="password" autoComplete="current-password" autoFocus placeholder="bb_…" value={token}
              onChange={(event) => setToken(event.target.value)} aria-invalid={error !== null} className="font-mono" />
            {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={!token.trim() || pending}>
            {pending ? <Loader2 className="animate-spin" /> : <KeyRound />} Sign in
          </Button>
          <p className="text-muted-foreground text-xs">The token is kept in an HttpOnly cookie on this browser for 30 days.</p>
        </form>
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">No token? Whoever runs the server can create one:</p>
          <Command>benchboard token create NAME --scope read</Command>
        </div>
      </div>
    </div>
  );
}
