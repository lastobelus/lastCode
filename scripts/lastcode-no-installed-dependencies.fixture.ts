// A `node --import` hook that fails any import a checkout without node_modules could not resolve.
const source = `import { isBuiltin, registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBuiltin(specifier) && !/^(?:\\.{0,2}\\/|file:)/u.test(specifier))
      throw new Error("Imports an installed dependency: " + specifier);
    return nextResolve(specifier, context);
  },
});`;

export const NO_INSTALLED_DEPENDENCIES_IMPORT = `data:text/javascript,${encodeURIComponent(source)}`;
