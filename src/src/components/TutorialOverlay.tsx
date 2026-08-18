import { useEffect, useMemo, useState } from "react";

import {
  TUTORIAL_MODULES,
  findStep,
  type TutorialLiveState,
} from "../tutorial/tutorialContent";

export type TutorialOverlayMode = "guide" | "training";

type Props = {
  mode: TutorialOverlayMode | null;
  liveState: TutorialLiveState;
  onClose: () => void;
};

type Rect = { top: number; left: number; width: number; height: number };

function useTargetRect(selector: string | undefined): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    let frame = 0;
    const update = () => {
      const element = document.querySelector(selector);
      if (element) {
        const box = element.getBoundingClientRect();
        setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
      } else {
        setRect(null);
      }
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [selector]);

  return rect;
}

export function TutorialOverlay({ mode, liveState, onClose }: Props) {
  const [activeStepId, setActiveStepId] = useState<string>(
    TUTORIAL_MODULES[0]?.steps[0]?.id ?? ""
  );

  useEffect(() => {
    if (mode) {
      setActiveStepId(TUTORIAL_MODULES[0]?.steps[0]?.id ?? "");
    }
  }, [mode]);

  const flatSteps = useMemo(
    () => TUTORIAL_MODULES.flatMap((module_) => module_.steps.map((step) => step.id)),
    []
  );

  const found = findStep(activeStepId);
  const rect = useTargetRect(found?.step.targetSelector);

  // 訓練モードだけ、実際の操作が検知できたら自動で次のステップへ進む。
  useEffect(() => {
    if (mode !== "training" || !found) return;
    const { step } = found;
    if (!step.liveCheck) return;
    if (!step.liveCheck(liveState)) return;
    const currentIndex = flatSteps.indexOf(step.id);
    const nextId = flatSteps[currentIndex + 1];
    if (nextId) {
      const timer = window.setTimeout(() => setActiveStepId(nextId), 500);
      return () => window.clearTimeout(timer);
    }
    return undefined;
    // liveStateの変化を検知するたびに再評価する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, found, liveState, flatSteps]);

  if (!mode || !found) return null;

  const currentIndex = flatSteps.indexOf(found.step.id);
  const goTo = (offset: number) => {
    const nextId = flatSteps[currentIndex + offset];
    if (nextId) setActiveStepId(nextId);
  };

  const isTraining = mode === "training";
  const stepDone = found.step.liveCheck?.(liveState) ?? false;

  return (
    <div
      className={isTraining ? "tutorial-overlay training" : "tutorial-overlay"}
      role="dialog"
      aria-label={isTraining ? "チュートリアル" : "使い方"}
    >
      {rect && (
        <div
          className="tutorial-spotlight"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div className="tutorial-backdrop" onClick={isTraining ? undefined : onClose} />

      {!isTraining && (
        <nav className="tutorial-module-list" aria-label="使い方の目次">
          <div className="tutorial-module-list-header">
            <strong>使い方</strong>
            <button type="button" onClick={onClose} aria-label="閉じる">×</button>
          </div>
          {TUTORIAL_MODULES.map((module_) => (
            <div key={module_.id} className="tutorial-module-group">
              <p>{module_.title}</p>
              {module_.steps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className={step.id === activeStepId ? "active" : ""}
                  onClick={() => setActiveStepId(step.id)}
                >
                  {step.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
      )}

      <div className="tutorial-card">
        {isTraining && (
          <div className="tutorial-progress" aria-label="進捗">
            {currentIndex + 1} / {flatSteps.length}・{found.module.title}
          </div>
        )}
        <strong>{found.step.title}</strong>
        <p>{found.step.body}</p>
        {isTraining && found.step.liveCheck && (
          <p className={stepDone ? "tutorial-check done" : "tutorial-check"}>
            {stepDone ? "✓ 完了しました" : "実際にこの操作をすると自動で次へ進みます"}
          </p>
        )}
        <div className="tutorial-card-actions">
          {isTraining ? (
            <>
              <button type="button" onClick={onClose} className="tutorial-secondary">
                やめる
              </button>
              <button type="button" onClick={() => goTo(-1)} disabled={currentIndex === 0}>
                戻る
              </button>
              {!found.step.liveCheck && currentIndex < flatSteps.length - 1 && (
                <button type="button" onClick={() => goTo(1)}>次へ</button>
              )}
              {currentIndex === flatSteps.length - 1 && (
                <button type="button" onClick={onClose}>おわる</button>
              )}
            </>
          ) : (
            <button type="button" onClick={onClose}>閉じる</button>
          )}
        </div>
      </div>
    </div>
  );
}
