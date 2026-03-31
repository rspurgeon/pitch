export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function shouldAllowShellExpansion(value: string): boolean {
  return (
    value === "~" ||
    value.startsWith("~/") ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
  );
}

export function formatEnvAssignment(key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }

  return `${key}=${shouldAllowShellExpansion(value) ? value : shellEscape(value)}`;
}
