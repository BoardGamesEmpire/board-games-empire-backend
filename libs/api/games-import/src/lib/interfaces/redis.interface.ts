export interface RedisOptions {
  username?: string;
  password?: string;
  database?: number;
  socket: {
    host: string;
    port: number;
    tls: boolean;
    rejectUnauthorized?: boolean;
    ca?: string;
    key?: string;
    cert?: string;
  };
}
