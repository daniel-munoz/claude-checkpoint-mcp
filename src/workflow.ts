// The workflow a checkpoint belongs to (#55): set by a workflow engine that starts sessions as the
// steps of one run, so a crashed step can be recovered from the run's newest checkpoint. Imports
// nothing, so the hooks could use it without bundling zod.

/** A workflow run id: path-safe, and wide enough for UUIDs and engine job ids. */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The step of the run that wrote the checkpoint. */
export const STEP_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export const WORKFLOW_ID_ENV = "CHECKPOINT_WORKFLOW_ID";
export const WORKFLOW_STEP_ENV = "CHECKPOINT_WORKFLOW_STEP";

export interface WorkflowEnv {
  workflowId: string | null;
  step: string | null;
  warning?: string;
}

/** The workflow id and step from the environment. An unusable value is ignored and reported. */
export function resolveWorkflowEnv(id: string | undefined, step: string | undefined): WorkflowEnv {
  const warnings: string[] = [];
  const pick = (raw: string | undefined, pattern: RegExp, name: string): string | null => {
    if (!raw) return null;
    if (pattern.test(raw)) return raw;
    warnings.push(`${name} is not a usable value; checkpoints are saved without it.`);
    return null;
  };
  const out: WorkflowEnv = {
    workflowId: pick(id, WORKFLOW_ID_PATTERN, WORKFLOW_ID_ENV),
    step: pick(step, STEP_PATTERN, WORKFLOW_STEP_ENV),
  };
  return warnings.length ? { ...out, warning: warnings.join(" ") } : out;
}
