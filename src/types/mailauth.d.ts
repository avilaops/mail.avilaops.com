/**
 * O mailauth nao publica tipos. Declaramos so a superficie que usamos, em vez
 * de afrouxar o strict do projeto inteiro com um `any` global.
 */

declare module "mailauth" {
  export interface AuthenticateOptions {
    ip?: string;
    helo?: string;
    sender?: string;
    mta?: string;
    disableArc?: boolean;
    disableDmarc?: boolean;
    disableBimi?: boolean;
  }

  export interface AuthenticationResult {
    dkim?: {
      results?: Array<{
        status?: { result?: string; comment?: string };
        signingDomain?: string;
        selector?: string;
      }>;
    };
    spf?: {
      status?: { result?: string; comment?: string };
      domain?: string;
    };
    dmarc?: {
      status?: { result?: string; header?: { from?: string } };
      policy?: string;
    };
    arc?: { status?: { result?: string } };
    receivedChain?: unknown;
    headers?: string;
  }

  export function authenticate(
    message: Buffer | string,
    options?: AuthenticateOptions,
  ): Promise<AuthenticationResult>;
}

declare module "mailauth/lib/dkim/sign.js" {
  export interface DkimSignatureData {
    signingDomain: string;
    selector: string;
    privateKey: string;
    algorithm?: string;
    canonicalization?: string;
    headerList?: string;
  }

  export interface DkimSignOptions {
    canonicalization?: string;
    algorithm?: string;
    signTime?: Date;
    signatureData: DkimSignatureData[];
  }

  export interface DkimSignResult {
    signatures?: string;
    errors?: unknown[];
  }

  export function dkimSign(message: Buffer | string, options: DkimSignOptions): Promise<DkimSignResult>;
}
