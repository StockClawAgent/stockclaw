// Software WebAuthn authenticator for e2e (ES256, "none" attestation). Produces real registration and assertion
// responses that @simplewebauthn/server verifies exactly like a browser's; no test-only verifier in the server.
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const b64u = (b: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(b));
export function virtualAuthenticator(rpId: string, origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credId = randomBytes(16);
  let counter = 0;
  const authData = (flags: number, attested?: Uint8Array) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
    return Buffer.concat([sha(rpId), Buffer.from([flags]), c, ...(attested ? [attested] : [])]);
  };
  return {
    credentialId: b64u(credId),
    register(opts: { challenge: string }) {
      const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const ad = authData(0x45, Buffer.concat([Buffer.alloc(16), len, credId, Buffer.from(cose)])); // UP|UV|AT
      const attObj = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(ad)]]) as any);
      const cd = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin, crossOrigin: false }));
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), attestationObject: b64u(attObj), transports: ["internal"] } };
    },
    assert(challenge: string, o: { tamper?: boolean; noUV?: boolean } = {}) {
      const ad = authData(o.noUV ? 0x01 : 0x05); // UP|UV
      const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const sig = edSign("sha256", Buffer.concat([ad, sha(cd)]), privateKey);
      if (o.tamper) sig[sig.length - 1] ^= 1;
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: undefined } };
    },
  };
}
