import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Signing in, without the officer typing anything.
 *
 * RFC 8252 loopback redirect with PKCE (RFC 7636) — the same shape `gh`, `gcloud` and
 * `aws` use. We open a port on 127.0.0.1, send the officer's **real** browser to the
 * consent page (where they are already signed in), and catch the redirect.
 *
 * Device-code flow was considered and rejected: it exists for devices that cannot open a
 * browser or receive a redirect, and this can do both. Making someone read digits off a
 * screen for no reason is not a neutral choice.
 *
 * The one click of consent is deliberate and is not worth optimising away. Without it,
 * any process on this machine could open the same URL, listen on its own loopback port
 * and be handed a token — the click is the only thing separating "the app the officer
 * just launched" from "something else running on their PC". That matters more here than
 * usual, because what is asking is an unsigned binary with no publisher identity.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 §4.1: 43–128 characters of unreserved alphabet. 32 bytes base64url is 43. */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface LoopbackResult {
  code: string;
  port: number;
}

export class SignInCancelledError extends Error {
  constructor(message = 'Sign-in was cancelled.') {
    super(message);
    this.name = 'SignInCancelledError';
  }
}

/**
 * A one-shot loopback listener.
 *
 * Bound to `127.0.0.1` rather than `localhost`: the hostname can resolve elsewhere, and
 * the address is the thing we actually mean. Port 0 lets the OS pick an ephemeral one,
 * which RFC 8252 requires the server to accept.
 */
export class LoopbackReceiver {
  private server: Server | null = null;
  private resolvePort: ((port: number) => void) | null = null;

  /** Random, unguessable, and checked on the way back in — this is the CSRF defence. */
  readonly state = base64Url(randomBytes(16));

  /**
   * Start listening. Resolves with the code once the browser comes back, or rejects on
   * timeout — a sign-in nobody completes must not leave a socket open forever.
   */
  async listen(timeoutMs = 120_000): Promise<{ port: number; code: Promise<LoopbackResult> }> {
    const portPromise = new Promise<number>((resolve) => (this.resolvePort = resolve));

    const code = new Promise<LoopbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new SignInCancelledError('Sign-in timed out. Try again from the app.'));
      }, timeoutMs);

      this.server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');

        // Browsers ask for /favicon.ico and anything else on the machine may probe this
        // port. Only the callback path with a matching state is a real answer.
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const returnedState = url.searchParams.get('state');
        const returnedCode = url.searchParams.get('code');

        if (returnedState !== this.state || !returnedCode) {
          respond(res, 'Something went wrong', 'That response did not match this sign-in. Start again from the app.');
          clearTimeout(timer);
          this.close();
          reject(new SignInCancelledError('The sign-in response did not match this request.'));
          return;
        }

        respond(res, "You're connected", 'You can close this tab and go back to Raidify Companion.');
        clearTimeout(timer);

        const port = (this.server?.address() as AddressInfo | null)?.port ?? 0;
        // Let the response flush before tearing the socket down.
        setTimeout(() => this.close(), 50);
        resolve({ code: returnedCode, port });
      });

      this.server.on('error', (error) => {
        clearTimeout(timer);
        this.close();
        reject(error);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server!.address() as AddressInfo;
        this.resolvePort?.(port);
      });
    });

    // The caller does real work between receiving this promise and awaiting it — it
    // opens a browser — and the flow can fail during that gap: a stale tab replaying an
    // old callback, or a probe on the port. A rejection with no handler attached yet is
    // an unhandled rejection, which in the main process is a crash on some Node
    // configurations. Marking it handled here changes nothing for the caller, who still
    // receives the same rejection when they get round to awaiting it.
    code.catch(() => {});

    return { port: await portPromise, code };
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }
}

/** The consent page the browser is sent to. */
export function buildAuthorizeUrl(
  baseUrl: string,
  { challenge, port, state }: { challenge: string; port: number; state: string },
): string {
  const url = new URL('/companion/authorize', baseUrl.replace(/\/+$/, ''));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('port', String(port));
  url.searchParams.set('state', state);
  return url.toString();
}

/** The page the officer briefly sees before closing the tab. */
function respond(res: import('node:http').ServerResponse, title: string, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#22252c; color:#f4f2f7;
         font:16px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  main { text-align:center; padding:2rem; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p { margin:0; color:#a8a2b4; }
</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`);
}
