export type Config = {
  databaseUrl: string;
  adminPassword: string;
  publicUrl: string;
  port: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = required(env, 'DATABASE_URL');
  const adminPassword = required(env, 'CCC_ADMIN_PASSWORD');
  if (adminPassword.length < 12) throw new Error('CCC_ADMIN_PASSWORD must be at least 12 characters');
  const publicUrl = required(env, 'CCC_PUBLIC_URL').replace(/\/+$/, '');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer');
  return { databaseUrl, adminPassword, publicUrl, port };
}
