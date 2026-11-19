import {
  browserSupportsWebAuthn,
  startRegistration,
  startAuthentication,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { post } from './api';
import type { Session } from './types';
export const supportsPasskeys = () => window.isSecureContext && browserSupportsWebAuthn();
export async function addPasskey() {
  const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>(
    '/auth/passkeys/register/options',
    {},
  );
  const credential = await startRegistration({ optionsJSON });
  await post('/auth/passkeys/register/verify', { challenge: optionsJSON.challenge, credential });
}
export async function signInWithPasskey() {
  const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>(
    '/auth/passkeys/sign-in/options',
    {},
  );
  const credential = await startAuthentication({ optionsJSON });
  return post<Session>('/auth/passkeys/sign-in/verify', {
    challenge: optionsJSON.challenge,
    credential,
  });
}
