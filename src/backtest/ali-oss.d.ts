declare module "ali-oss" {
  interface AliOssResponse {
    readonly status?: number;
    readonly headers?: Record<string, string | undefined>;
    readonly size?: number;
  }

  interface AliOssHeadResult {
    readonly status?: number;
    readonly res?: AliOssResponse;
  }

  interface AliOssGetResult {
    readonly res?: AliOssResponse;
    readonly content?: Buffer;
  }

  interface AliOssClient {
    head(name: string, options?: Record<string, unknown>): Promise<AliOssHeadResult>;
    get(name: string, options?: Record<string, unknown>): Promise<AliOssGetResult>;
  }

  interface AliOssOptions {
    accessKeyId: string;
    accessKeySecret: string;
    stsToken?: string;
    bucket: string;
    endpoint?: string;
    region?: string;
    authorizationV4?: boolean;
    retryMax?: number;
    timeout?: number;
  }

  const OSS: new (options: AliOssOptions) => AliOssClient;
  export default OSS;
}
