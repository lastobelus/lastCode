import { useAtomValue } from "@effect/atom-react";
import { ARCHIVE_TYPED_IN_LABEL } from "@t3tools/client-runtime/state/thread-archive";
import { useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { cn } from "../../lib/cn";
import {
  finishMobileArchiveDialog as finish,
  mobileArchiveDialogAtom,
  registerMobileArchiveDialogHost,
  type MobileArchiveDialogRequest,
} from "./lastCodeMobileArchiveDialogState";

export function LastCodeMobileArchiveDialogHost() {
  const request = useAtomValue(mobileArchiveDialogAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only the mounted host can collect consent and it cancels outstanding requests when removed
  useEffect(registerMobileArchiveDialogHost, []);
  return request ? <ArchiveDialog request={request} /> : null;
}

function ArchiveDialog({ request }: { readonly request: MobileArchiveDialogRequest }) {
  const gt = useGT();
  const messages = useMessages();
  const [includeTypedIn, setIncludeTypedIn] = useState(false);
  const confirmation = request.confirm(includeTypedIn);
  return (
    <Sheet title={request.title} onClose={() => finish(request, null)}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 p-4">
        <AppText>{confirmation.message}</AppText>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: includeTypedIn }}
          onPress={() => setIncludeTypedIn(!includeTypedIn)}
          className="min-h-12 flex-row items-center gap-3"
        >
          <View
            className={cn(
              "size-5 items-center justify-center rounded",
              includeTypedIn ? "bg-primary" : "border border-input-border",
            )}
          >
            {includeTypedIn && (
              <SymbolView
                name="checkmark"
                size={13}
                tintColorClassName="accent-primary-foreground"
              />
            )}
          </View>
          <AppText className="flex-1">{messages(ARCHIVE_TYPED_IN_LABEL)}</AppText>
        </Pressable>
        <View className="flex-row flex-wrap gap-2">
          <Button label={gt("Cancel")} onPress={() => finish(request, null)} />
          {request.canReview && (
            <Button
              label={gt("Review", { $context: "verb, inspect a thread before archiving" })}
              onPress={() => finish(request, "review")}
            />
          )}
          {!confirmation.blocked && (
            <Button
              label={confirmation.confirmLabel}
              tone="danger"
              onPress={() => finish(request, { includeTypedIn })}
            />
          )}
        </View>
      </ScrollView>
    </Sheet>
  );
}
