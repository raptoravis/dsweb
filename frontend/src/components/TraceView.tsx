import type { TraceStep } from "../api";

interface Props {
  steps: TraceStep[];
}

/** Agent execution trace — collapsed by default, expandable. */
export function TraceView({ steps }: Props) {
  if (steps.length === 0) return null;
  return (
    <details className="trace">
      <summary>执行轨迹（{steps.length} 步）</summary>
      <div className="steps">
        {steps.map((step) => (
          <div key={step.id} className={`trace-step ${step.status}`}>
            <div className="step-title">
              {step.title}
              {step.status === "running" ? " …" : ""}
            </div>
            {step.detail != null && (
              <div className="step-detail">
                {typeof step.detail === "string"
                  ? step.detail
                  : JSON.stringify(step.detail, null, 2)}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
