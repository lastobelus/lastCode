import type { EnvironmentId, PreviewHostingLeaseSummary, ThreadId } from "@t3tools/contracts";
import { resolveMobileMarkdownMediaSource } from "../../lib/markdownMediaSource";
import { getBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { useCallback, useMemo, useState } from "react";
import * as Option from "effect/Option";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  openThreadFeedMarkdownUrl,
  preparedThreadFeedMediaActionsSource,
} from "../../lib/prepareThreadFeedPreview";
import { useFontFamily } from "../../lib/useFontFamily";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageView,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownPreparedUri,
} from "../threads/ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "../threads/ThreadMarkdownVideo";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { normalizeNativeMarkdownUrl } from "../../lib/markdownLinks";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { resolveWorkspaceFilePath } from "./filePath";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection, useConfiguredPreviewEnvironmentUrl } from "../../state/session";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

interface MarkdownPreviewStyles {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

export function useMarkdownPreviewStyles(): MarkdownPreviewStyles {
  const { appearance } = useAppearancePreferences();
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const theme = useUniwindTheme();
  const body = theme["--color-md-body"];
  const strong = theme["--color-md-strong"];
  const link = theme["--color-md-link"];
  const blockquoteBorder = theme["--color-md-blockquote-border"];
  const codeBackground = theme["--color-md-code-bg"];
  const codeText = theme["--color-md-code-text"];
  const horizontalRule = theme["--color-md-hr"];
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    return {
      nativeTextStyle: {
        color: body,
        strongColor: strong,
        mutedColor: body,
        linkColor: link,
        inlineCodeColor: codeText,
        codeColor: codeText,
        codeBackgroundColor: codeBackground,
        codeBlockBackgroundColor: codeBackground,
        fileTextColor: codeText,
        skillTextColor: codeText,
        quoteMarkerColor: blockquoteBorder,
        dividerColor: horizontalRule,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    };
  }, [
    blockquoteBorder,
    body,
    codeBackground,
    codeText,
    horizontalRule,
    link,
    nativeMarkdownTypography,
    regularFontFamily,
    strong,
    boldFontFamily,
  ]);
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly captured?: boolean;
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly relativePath: string;
  /** Absent for a file opened from a project draft, which has no thread yet. */
  readonly threadId: ThreadId | null;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const listHostedPreviews = useAtomCommand(previewEnvironment.hostingList, {
    reportFailure: false,
  });
  const recoverHostedPreviewLease = useAtomCommand(previewEnvironment.hostingRecover, {
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const handlePullToRefresh = useCallback(async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [props.onRefresh]);
  const markdownDirectory = useMemo(
    () => getBrowseDirectoryPath(resolveWorkspaceFilePath(props.cwd, props.relativePath)),
    [props.cwd, props.relativePath],
  );
  const connection = Option.getOrNull(preparedConnection);
  const knownEnvironmentUrl = useConfiguredPreviewEnvironmentUrl(props.environmentId, connection);
  const prepareMediaUrl = useCallback(
    (href: string, purpose: "navigation" | "resource" = "resource") => {
      const threadRef =
        props.threadId === null
          ? null
          : { environmentId: props.environmentId, threadId: props.threadId };
      return openThreadFeedMarkdownUrl(
        threadRef === null || connection === null
          ? null
          : {
              threadRef,
              purpose,
              environmentUrl: connection.httpBaseUrl,
              knownEnvironmentUrls: knownEnvironmentUrl === null ? [] : [knownEnvironmentUrl],
              list: async () => {
                const result = await listHostedPreviews({
                  environmentId: props.environmentId,
                  input: { threadId: threadRef.threadId },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                return result.value;
              },
              recover: async (
                lease: PreviewHostingLeaseSummary,
                options: { readonly bootstrap: boolean },
              ) => {
                const result = await recoverHostedPreviewLease({
                  environmentId: props.environmentId,
                  input: {
                    threadId: threadRef.threadId,
                    leaseId: lease.leaseId,
                    url: lease.url,
                    bootstrap: options.bootstrap,
                  },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                return result.value;
              },
            },
        href,
        (url) => url,
      );
    },
    [
      connection,
      knownEnvironmentUrl,
      listHostedPreviews,
      props.environmentId,
      props.threadId,
      recoverHostedPreviewLease,
    ],
  );
  const openExternalLink = useCallback(
    (href: string) => {
      void prepareMediaUrl(href, "navigation")
        .then((url) => tryOpenExternalUrl(url, "markdown-link"))
        .catch(() =>
          Alert.alert(
            "Preview unavailable",
            "The preview could not be restored. Tap the link to retry.",
          ),
        );
    },
    [prepareMediaUrl],
  );
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const media = resolveMobileMarkdownMediaSource(image.href, {
        threadId: props.threadId ?? undefined,
        workspaceRoot: markdownDirectory,
        imageEmbed: true,
      });
      const preview = resolveMarkdownMediaPreview(image.href, {
        environmentId: props.environmentId,
        threadId: props.threadId ?? undefined,
        workspaceRoot: markdownDirectory,
        captured: props.captured,
        imageEmbed: true,
      });
      if (media?.access === "direct") {
        const originalUri = normalizeNativeMarkdownUrl(media.uri);
        const sourceKey = JSON.stringify([
          props.environmentId,
          props.threadId,
          connection?.httpBaseUrl,
          originalUri,
        ]);
        return (
          <ThreadMarkdownPreparedUri
            key={image.href}
            uri={originalUri}
            sourceKey={sourceKey}
            prepareUrl={prepareMediaUrl}
          >
            {({ uri, status }) =>
              media.kind === "video" ? (
                <MediaVideoPlayer
                  uri={uri}
                  unavailable={status === "unavailable"}
                  name={image.alt ?? "Video"}
                  thumbnailKey={sourceKey}
                  thumbnailVisible
                  actionsSource={preparedThreadFeedMediaActionsSource(
                    preview?.source.actionsSource,
                    uri ?? originalUri,
                  )}
                  resolvePlaybackUri={() => prepareMediaUrl(originalUri)}
                />
              ) : (
                <ThreadMarkdownImageView
                  uri={uri}
                  sourceKey={sourceKey}
                  unavailable={status === "unavailable"}
                  alt={image.alt}
                  format={media.mimeType === "image/svg+xml" ? "svg" : undefined}
                  actionsSource={preparedThreadFeedMediaActionsSource(
                    preview?.source.actionsSource,
                    uri ?? originalUri,
                  )}
                  onPressPreview={(source) => {
                    void prepareMediaUrl(originalUri).then((url) =>
                      setExpandedFile({
                        ...source,
                        uri: url,
                        actionsSource: preparedThreadFeedMediaActionsSource(
                          source.actionsSource,
                          url,
                        ),
                      }),
                    );
                  }}
                />
              )
            }
          </ThreadMarkdownPreparedUri>
        );
      }
      if (props.captured || media === null || media.access === "unavailable") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      if (media.kind === "video") {
        return preview?.kind === "video" ? (
          <ThreadMarkdownVideo source={preview.source} thumbnailVisible />
        ) : (
          <ThreadMarkdownImageUnavailable alt={image.alt} />
        );
      }
      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          resource={media.resource}
          alt={image.alt}
          srcFragment={media.srcFragment}
          actionsSource={preview?.source.actionsSource}
          onPressPreview={setExpandedFile}
        />
      );
    },
    [
      markdownDirectory,
      props.environmentId,
      props.threadId,
      props.captured,
      connection,
      prepareMediaUrl,
    ],
  );
  const styles = useMarkdownPreviewStyles();
  const resolveNativeImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: markdownDirectory,
    captured: props.captured,
  });
  const resolveImageSource = useCallback<MarkdownImageSourceResolver>(
    async (image) => {
      const source = await resolveNativeImageSource(image);
      return source && /^(?:https?:)?\/\//i.test(image.href)
        ? { ...source, uri: await prepareMediaUrl(source.uri) }
        : source;
    },
    [resolveNativeImageSource, prepareMediaUrl],
  );
  const openMedia = useCallback(
    (href: string, imageEmbed = false) => {
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: props.threadId ?? undefined,
        workspaceRoot: markdownDirectory,
        captured: props.captured,
        imageEmbed,
      });
      if (!media) return false;
      const open = (uri?: string) => {
        if (media.kind === "video") {
          setExpandedVideo(
            uri
              ? {
                  ...media.source,
                  uri,
                  actionsSource: preparedThreadFeedMediaActionsSource(
                    media.source.actionsSource,
                    uri,
                  ),
                }
              : media.source,
          );
        } else {
          setExpandedFile(
            uri
              ? {
                  ...media.source,
                  uri,
                  actionsSource: preparedThreadFeedMediaActionsSource(
                    media.source.actionsSource,
                    uri,
                  ),
                }
              : media.source,
          );
        }
      };
      if ("uri" in media.source && /^https?:\/\//i.test(media.source.uri)) {
        void prepareMediaUrl(media.source.uri)
          .then(open)
          .catch(() =>
            Alert.alert(
              "Preview unavailable",
              "The preview could not be restored. Tap the link to retry.",
            ),
          );
      } else open();
      return true;
    },
    [markdownDirectory, props.environmentId, props.threadId, props.captured, prepareMediaUrl],
  );
  const onImagePress = useCallback(
    (href: string) => {
      openMedia(href, true);
    },
    [openMedia],
  );
  const onLinkPress = useCallback(
    (href: string) => {
      if (!openMedia(href)) openExternalLink(href);
    },
    [openMedia, openExternalLink],
  );

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 18 }}
      refreshControl={
        props.onRefresh ? (
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullToRefresh()}
          />
        ) : undefined
      }
    >
      <View className="mx-auto w-full max-w-[760px]">
        <SelectableMarkdownText
          markdown={props.markdown}
          onLinkPress={onLinkPress}
          renderImage={renderImage}
          resolveImageSource={resolveImageSource}
          onImagePress={onImagePress}
          textStyle={styles.nativeTextStyle}
        />
        <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
        <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
      </View>
    </ScrollView>
  );
}
