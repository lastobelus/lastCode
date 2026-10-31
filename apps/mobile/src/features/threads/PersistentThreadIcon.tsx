import Svg, { Path, Rect } from "react-native-svg";

export function PersistentThreadIcon(props: { readonly color: string; readonly size?: number }) {
  const size = props.size ?? 14;
  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M22 17a2 2 0 0 1-2 2H6.83a2 2 0 0 0-1.42.59l-2.2 2.2A.71.71 0 0 1 2 21.29V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      <Rect width={8} height={5} x={8} y={10} rx={1} />
      <Path d="M10 10V8a2 2 0 0 1 4 0v2" />
    </Svg>
  );
}
