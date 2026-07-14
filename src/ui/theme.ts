/**
 * Burrow — "toast" CodeMirror theme: warm graphite + baked-amber accent,
 * matching the CSS custom properties in styles.css (src/ui internal).
 */
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const viewTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--fg0)",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.55",
    },
    ".cm-content": {
      caretColor: "var(--acc)",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--acc)" },
    ".cm-selectionBackground": { backgroundColor: "rgba(242, 163, 76, 0.10)" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(242, 163, 76, 0.20)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(242, 163, 76, 0.12)" },
    ".cm-activeLine": { backgroundColor: "rgba(236, 227, 210, 0.04)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--fg1)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--fg2)",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "40px", padding: "0 12px 0 8px" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--fg2)" },
    "&.cm-focused": { outline: "none" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(242, 163, 76, 0.14)",
      outline: "1px solid rgba(242, 163, 76, 0.35)",
    },
    ".cm-nonmatchingBracket": { color: "var(--err)" },
    ".cm-searchMatch": {
      backgroundColor: "rgba(130, 184, 216, 0.18)",
      outline: "1px solid rgba(130, 184, 216, 0.35)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(242, 163, 76, 0.28)" },
    ".cm-panels": {
      backgroundColor: "var(--bg2)",
      color: "var(--fg0)",
      fontFamily: "var(--mono)",
    },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
    ".cm-panel button, .cm-panel input": { fontFamily: "var(--mono)" },
    ".cm-textfield": {
      backgroundColor: "var(--bg0)",
      border: "1px solid var(--line2)",
      color: "var(--fg0)",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--bg3)",
      border: "1px solid var(--line2)",
      color: "var(--fg0)",
      borderRadius: "4px",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg2)",
      border: "1px solid var(--line2)",
      color: "var(--fg0)",
      fontFamily: "var(--mono)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--acc-dim)",
      color: "var(--acc-hi)",
    },
    ".cm-placeholder": { color: "var(--fg2)" },
  },
  { dark: true },
);

const toastHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "#f2a34c" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#b3c186" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#dd9271" },
  { tag: t.comment, color: "#6e6455", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#ecd9ae" },
  { tag: [t.typeName, t.className, t.namespace], color: "#d8bf8f" },
  { tag: t.definition(t.variableName), color: "#ece3d2" },
  { tag: t.variableName, color: "#dcd3c2" },
  { tag: [t.propertyName, t.labelName], color: "#c9bda9" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#8d8272" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "#a99e8c" },
  { tag: t.tagName, color: "#f2a34c" },
  { tag: t.attributeName, color: "#d8bf8f" },
  { tag: t.self, color: "#dd9271" },
  { tag: t.invalid, color: "#e5716a" },
]);

/** Base editor look shared by the main editor and the diff panel. */
export const burrowTheme: Extension = [viewTheme, syntaxHighlighting(toastHighlight)];
