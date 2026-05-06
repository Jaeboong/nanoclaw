const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface ResolvedContainerEnv {
  name: string;
  value: string;
}

export function resolveContainerEnv(
  names: string[] | undefined,
  source: Record<string, string | undefined>,
): ResolvedContainerEnv[] {
  const out: ResolvedContainerEnv[] = [];
  const seen = new Set<string>();
  for (const raw of names ?? []) {
    const name = raw.trim();
    if (!ENV_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const value = source[name];
    if (value) out.push({ name, value });
  }
  return out;
}
