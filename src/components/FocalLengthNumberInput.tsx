import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  FOCAL_LENGTH_MAX,
  FOCAL_LENGTH_MIN,
} from "../types/camera";
import { parseFocalLengthInput } from "../utils/focalLengthInput";

type Props = {
  value: number;
  onChange: (value: number) => void;
  onValidityChange?: (valid: boolean) => void;
  ariaLabel: string;
  ariaDescribedBy?: string;
};

/**
 * 全画面で同一の焦点距離入力仕様を使う。
 * 入力途中は自由編集を許可し、有効値だけを撮影計算へ渡す。
 */
export function FocalLengthNumberInput({
  value,
  onChange,
  onValidityChange,
  ariaLabel,
  ariaDescribedBy,
}: Props) {
  const [inputValue, setInputValue] = useState(String(value));
  const [inputValid, setInputValid] = useState(true);
  const [errorOpen, setErrorOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onValidityChangeRef = useRef(onValidityChange);
  const dialogTitleId = useId();
  onValidityChangeRef.current = onValidityChange;

  const updateValidity = (valid: boolean) => {
    setInputValid(valid);
    onValidityChangeRef.current?.(valid);
  };

  useEffect(() => {
    // ズームやスライダーなど、入力欄以外から変更された値も同期する。
    if (document.activeElement !== inputRef.current) {
      setInputValue(String(value));
      setInputValid(true);
      setErrorOpen(false);
      onValidityChangeRef.current?.(true);
    }
  }, [value]);

  useEffect(() => {
    if (!errorOpen) return;
    closeButtonRef.current?.focus();

    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setErrorOpen(false);
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [errorOpen]);

  const commitInput = () => {
    const result = parseFocalLengthInput(inputValue);
    updateValidity(result.valid);
    if (!result.valid) {
      setErrorOpen(true);
      return;
    }

    setInputValue(String(result.value));
    onChange(result.value);
  };

  const validationDialog = errorOpen && typeof document !== "undefined"
    ? createPortal(
        <div
          className="focal-length-validation-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setErrorOpen(false);
          }}
        >
          <section
            className="focal-length-validation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
          >
            <strong id={dialogTitleId}>焦点距離を確認してください</strong>
            <p>
              焦点距離には{FOCAL_LENGTH_MIN}～{FOCAL_LENGTH_MAX}の数字を入力してください。
            </p>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setErrorOpen(false)}
            >
              閉じる
            </button>
          </section>
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={inputValue}
        aria-label={ariaLabel}
        aria-invalid={!inputValid}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => {
          const nextInput = event.target.value;
          const result = parseFocalLengthInput(nextInput);
          setInputValue(nextInput);
          updateValidity(result.valid);
          if (errorOpen) setErrorOpen(false);
          if (result.valid) onChange(result.value);
        }}
        onBlur={commitInput}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {validationDialog}
    </>
  );
}
