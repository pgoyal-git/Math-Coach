"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "mathlive";
import type { MathfieldElement } from "mathlive";
import {
  mathLiveLatexToMixedDisplay,
  mathLiveLatexToSubmitText,
} from "@/lib/mathText";

type MathStepInputProps = {
  value: string;
  disabled: boolean;
  placeholder: string;
  maxChars?: number;
  autoFocus?: boolean;
  modeResetKey?: string | null;
  onChange: (value: string, displayValue?: string | null) => void;
  onSubmit: () => void;
};

function textPlaceholderLatex(text: string) {
  const escaped = text.replace(/\\/g, "\\textbackslash{}").replace(/[{}]/g, "");
  return `\\text{${escaped}}`;
}

function stripInvisibleDraftArtifacts(value: string) {
  return value
    .replace(/\\text\s*\{\s*\}/g, "")
    .replace(/\\placeholder(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[{}]/g, "")
    .trim();
}

function hasVisibleMathfieldContent(mathfield: MathfieldElement) {
  const plainText = mathfield.getValue("plain-text") || "";
  const latexWithoutPlaceholders = mathfield.getValue("latex-without-placeholders") || "";

  return Boolean(
    stripInvisibleDraftArtifacts(plainText) ||
      stripInvisibleDraftArtifacts(latexWithoutPlaceholders)
  );
}

export default function MathStepInput({
  value,
  disabled,
  placeholder,
  maxChars,
  autoFocus = false,
  modeResetKey,
  onChange,
  onSubmit,
}: MathStepInputProps) {
  const inputShellRef = useRef<HTMLDivElement | null>(null);
  const mathfieldRef = useRef<MathfieldElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const isTypingNumericExponentRef = useRef(false);
  const lastAcceptedLatexRef = useRef("");
  const [entryMode, setEntryMode] = useState<"math" | "text">("text");

  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
  }, [onChange, onSubmit]);

  const scrollInputIntoView = useCallback(() => {
    const shell = inputShellRef.current;
    if (!shell) return;

    shell.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, []);

  useEffect(() => {
    const mathfield = mathfieldRef.current;
    if (!mathfield) return;

    mathfield.defaultMode = "text";
    mathfield.mathVirtualKeyboardPolicy = "auto";
    mathfield.placeholder = textPlaceholderLatex(placeholder);
    mathfield.smartFence = true;
    mathfield.smartMode = false;
    mathfield.smartSuperscript = false;
    mathfield.removeExtraneousParentheses = false;

    const syncValue = () => {
      if (!hasVisibleMathfieldContent(mathfield)) {
        onChangeRef.current("", null);
        return;
      }

      const latex = mathfield.getValue("latex-without-placeholders") || "";
      const submitValue = mathLiveLatexToSubmitText(latex);
      if (maxChars && submitValue.length > maxChars) {
        if (mathfield.value !== lastAcceptedLatexRef.current) {
          mathfield.value = lastAcceptedLatexRef.current;
        }
        return;
      }
      lastAcceptedLatexRef.current = latex;
      onChangeRef.current(submitValue, submitValue ? mathLiveLatexToMixedDisplay(latex) : null);
    };
    const syncAfterMathLiveUpdate = () => {
      window.requestAnimationFrame(syncValue);
      window.setTimeout(syncValue, 0);
      window.setTimeout(syncValue, 50);
    };
    const handleModeChange = () => {
      isTypingNumericExponentRef.current = false;
      setEntryMode(mathfield.mode === "text" ? "text" : "math");
    };
    const keepFocusedInputVisible = () => {
      window.requestAnimationFrame(scrollInputIntoView);
    };
    const handleClick = () => {
      isTypingNumericExponentRef.current = false;
      keepFocusedInputVisible();
    };
    const handleModeToggleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      event.preventDefault();
      event.stopPropagation();

      const nextMode = mathfield.mode === "text" ? "math" : "text";
      mathfield.executeCommand(["switchMode", nextMode]);
      setEntryMode(nextMode);
      mathfield.focus();

      if (nextMode === "math") {
        window.mathVirtualKeyboard?.show({ animate: true });
      } else {
        window.mathVirtualKeyboard?.hide({ animate: true });
      }

      window.requestAnimationFrame(scrollInputIntoView);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onSubmitRef.current();
        return;
      }

      if (mathfield.mode === "math" && event.key === "^") {
        isTypingNumericExponentRef.current = true;
        return;
      }

      if (
        mathfield.mode === "math" &&
        isTypingNumericExponentRef.current &&
        event.key.length === 1 &&
        !/[0-9.]/.test(event.key)
      ) {
        mathfield.executeCommand("moveAfterParent");
        isTypingNumericExponentRef.current = false;
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        syncAfterMathLiveUpdate();
      }
    };
    const handleBeforeInput = (event: InputEvent) => {
      const insertedText = event.data || "";
      if (mathfield.mode !== "math" || !insertedText) return;

      if (insertedText === "^") {
        isTypingNumericExponentRef.current = true;
      } else if (
        isTypingNumericExponentRef.current &&
        !/^[0-9.]+$/.test(insertedText)
      ) {
        mathfield.executeCommand("moveAfterParent");
        isTypingNumericExponentRef.current = false;
      }

      syncAfterMathLiveUpdate();
    };

    mathfield.addEventListener("beforeinput", handleBeforeInput);
    mathfield.addEventListener("input", syncValue);
    mathfield.addEventListener("change", syncValue);
    mathfield.addEventListener("selection-change", syncAfterMathLiveUpdate);
    mathfield.addEventListener("keyup", syncAfterMathLiveUpdate);
    mathfield.addEventListener("cut", syncAfterMathLiveUpdate);
    mathfield.addEventListener("paste", syncAfterMathLiveUpdate);
    mathfield.addEventListener("mode-change", handleModeChange);
    mathfield.addEventListener("keydown", handleModeToggleKeyDown, {
      capture: true,
    });
    mathfield.addEventListener("keydown", handleKeyDown);
    mathfield.addEventListener("focus", keepFocusedInputVisible);
    mathfield.addEventListener("click", handleClick);
    mathfield.executeCommand(["switchMode", "text"]);

    return () => {
      mathfield.removeEventListener("beforeinput", handleBeforeInput);
      mathfield.removeEventListener("input", syncValue);
      mathfield.removeEventListener("change", syncValue);
      mathfield.removeEventListener("selection-change", syncAfterMathLiveUpdate);
      mathfield.removeEventListener("keyup", syncAfterMathLiveUpdate);
      mathfield.removeEventListener("cut", syncAfterMathLiveUpdate);
      mathfield.removeEventListener("paste", syncAfterMathLiveUpdate);
      mathfield.removeEventListener("mode-change", handleModeChange);
      mathfield.removeEventListener("keydown", handleModeToggleKeyDown, {
        capture: true,
      });
      mathfield.removeEventListener("keydown", handleKeyDown);
      mathfield.removeEventListener("focus", keepFocusedInputVisible);
      mathfield.removeEventListener("click", handleClick);
    };
  }, [maxChars, placeholder, scrollInputIntoView]);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    const keepVisibleAfterViewportChange = () => {
      if (document.activeElement !== mathfieldRef.current) return;
      if (visualViewport.scale !== 1) return;
      window.requestAnimationFrame(scrollInputIntoView);
    };

    visualViewport.addEventListener("resize", keepVisibleAfterViewportChange);

    return () => {
      visualViewport.removeEventListener("resize", keepVisibleAfterViewportChange);
    };
  }, [scrollInputIntoView]);

  useEffect(() => {
    const mathfield = mathfieldRef.current;
    if (!mathfield) return;

    mathfield.disabled = disabled;
  }, [disabled]);

  useEffect(() => {
    const mathfield = mathfieldRef.current;
    if (!mathfield || disabled || !autoFocus) return;

    const focusInput = () => {
      mathfield.focus();
    };

    window.requestAnimationFrame(focusInput);
    const timeout = window.setTimeout(focusInput, 80);

    return () => window.clearTimeout(timeout);
  }, [autoFocus, disabled]);

  useEffect(() => {
    const mathfield = mathfieldRef.current;
    if (!mathfield) return;

    if (!value && mathfield.value) {
      mathfield.value = "";
      lastAcceptedLatexRef.current = "";
      onChangeRef.current("", null);
    }
  }, [value]);

  useEffect(() => {
    const mathfield = mathfieldRef.current;
    if (!mathfield || !modeResetKey) return;

    mathfield.executeCommand(["switchMode", "text"]);
    setEntryMode("text");
  }, [modeResetKey]);

  function showMathKeyboard() {
    setEntryMode("math");
    window.setTimeout(() => {
      const mathfield = mathfieldRef.current;
      mathfield?.focus();
      mathfield?.executeCommand(["switchMode", "math"]);
      window.mathVirtualKeyboard?.show({ animate: true });
      scrollInputIntoView();
      window.setTimeout(scrollInputIntoView, 100);
      window.setTimeout(scrollInputIntoView, 280);
    }, 0);
  }

  function showTextInput() {
    setEntryMode("text");
    window.setTimeout(() => {
      const mathfield = mathfieldRef.current;
      mathfield?.focus();
      mathfield?.executeCommand(["switchMode", "text"]);
      scrollInputIntoView();
    }, 0);
  }

  return (
    <div
      ref={inputShellRef}
      className="flex min-w-0 flex-1 scroll-mb-48 items-center gap-1 rounded-lg border border-transparent bg-slate-50 px-2 py-1 focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100"
    >
      <button
        type="button"
        onClick={showMathKeyboard}
        disabled={disabled}
        title="Math keyboard"
        aria-label="Math keyboard"
        aria-pressed={entryMode === "math"}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
          entryMode === "math"
            ? "bg-blue-100 text-blue-800"
            : "text-slate-500 hover:bg-white hover:text-slate-800"
        }`}
      >
        ∑
      </button>
      <button
        type="button"
        onClick={showTextInput}
        disabled={disabled}
        title="Text mode"
        aria-label="Text mode"
        aria-pressed={entryMode === "text"}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
          entryMode === "text"
            ? "bg-blue-100 text-blue-800"
            : "text-slate-500 hover:bg-white hover:text-slate-800"
        }`}
      >
        Aa
      </button>

      <math-field
        ref={mathfieldRef}
        className="math-step-field min-w-0 flex-1"
        aria-label="Your next step"
      />
    </div>
  );
}
