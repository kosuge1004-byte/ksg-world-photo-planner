import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import typescript from "typescript";

const TYPESCRIPT_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * Production TypeScript modules use browser-bundler style extensionless imports.
 * Resolve only missing relative imports to their existing TypeScript source file,
 * leaving packages and Node built-ins to Node's default resolver.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND" ||
      !context.parentURL?.startsWith("file:") ||
      (!specifier.startsWith("./") && !specifier.startsWith("../"))
    ) {
      throw error;
    }

    for (const suffix of TYPESCRIPT_SUFFIXES) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      const path = fileURLToPath(candidate);
      if (existsSync(path) && statSync(path).isFile()) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts") && !url.endsWith(".tsx")) {
    return nextLoad(url, context);
  }

  const source = await readFile(fileURLToPath(url), "utf8");
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      jsx: typescript.JsxEmit.ReactJSX,
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: fileURLToPath(url),
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      typescript.formatDiagnostics(errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
  }
  return {
    format: "module",
    source: transpiled.outputText,
    shortCircuit: true,
  };
}
