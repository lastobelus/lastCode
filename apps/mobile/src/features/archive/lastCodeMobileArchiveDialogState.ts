import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";

type Choice =
  | {
      readonly includeTypedIn: boolean;
      readonly recoveryIndex?: number;
    }
  | "review"
  | null;
export type MobileArchiveDialogRequest = {
  readonly title: string;
  readonly confirm: (
    includeTypedIn: boolean,
    recoveryIndex: number,
  ) => {
    readonly message: string;
    readonly confirmLabel: string;
    readonly blocked: boolean;
    readonly canIncludeTypedIn?: boolean;
  };
  readonly recoveries?: readonly {
    readonly sourceArchiveCommandId: string;
    readonly label: string;
  }[];
  readonly canReview?: boolean;
  readonly resolve: (choice: Choice) => void;
};
export const mobileArchiveDialogAtom = Atom.make<MobileArchiveDialogRequest | null>(null);
let hostMounted = false;

export function registerMobileArchiveDialogHost() {
  hostMounted = true;
  return () => {
    hostMounted = false;
    const request = appAtomRegistry.get(mobileArchiveDialogAtom);
    if (request) finishMobileArchiveDialog(request, null);
  };
}

export function requestLastCodeMobileArchiveDialog(
  request: Omit<MobileArchiveDialogRequest, "resolve">,
) {
  if (!hostMounted || appAtomRegistry.get(mobileArchiveDialogAtom)) return Promise.resolve(null);
  return new Promise<Choice>((resolve) =>
    appAtomRegistry.set(mobileArchiveDialogAtom, { ...request, resolve }),
  );
}

export function finishMobileArchiveDialog(request: MobileArchiveDialogRequest, choice: Choice) {
  if (appAtomRegistry.get(mobileArchiveDialogAtom) !== request) return;
  appAtomRegistry.set(mobileArchiveDialogAtom, null);
  request.resolve(choice);
}
