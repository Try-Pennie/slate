// Pure helpers for org-configurable reason options (#346): slugging new codes,
// resolving store rows into pickable options with a coded-default fallback, and
// the locked/system codes that admins may not rename or retire.
// Run: node --experimental-strip-types scripts/test-reason-options.ts
import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  REASSIGN_REASONS,
} from "../src/lib/booking/core.ts";
import {
  slugifyCode,
  uniqueCode,
  LOCKED_CODES,
  resolveReasonOptions,
  loadReasonOptions,
  parseReasonOptionsForm,
  coerceReasonOptionsForm,
  resolveEditorRows,
  REASON_LABEL_MAX,
  type ReasonOptionRow,
  type ReasonOptionsFormInput,
} from "../src/lib/booking/reason-options.ts";
import { assert, finish } from "./lib/harness.ts";

// --- slugifyCode: label -> stable analytics code ---
{
  assert(slugifyCode("Cost concerns") === "cost_concerns", "spaces become underscores, lowercased");
  assert(slugifyCode("  VIP  Escalation!! ") === "vip_escalation", "trims, collapses runs, strips punctuation");
  assert(slugifyCode("Already got help") === "already_got_help", "multi-word slug");
  assert(slugifyCode("2nd choice") === "2nd_choice", "digits are kept");
  assert(slugifyCode("---") === "", "a label with no slug chars yields empty (caller must reject)");
}

// --- uniqueCode: never collide, never repurpose an existing code ---
{
  assert(uniqueCode("coverage", ["escalation"]) === "coverage", "free base is used as-is");
  assert(uniqueCode("coverage", ["coverage"]) === "coverage_2", "first collision -> _2");
  assert(
    uniqueCode("coverage", ["coverage", "coverage_2"]) === "coverage_3",
    "walks past taken suffixes",
  );
  assert(
    uniqueCode("coverage", new Set(["coverage"])) === "coverage_2",
    "accepts a Set of existing codes",
  );
}

// --- LOCKED_CODES: system rows admins cannot rename/retire/reorder off ---
{
  assert(LOCKED_CODES.reschedule.includes("other"), "reschedule locks 'other'");
  assert(LOCKED_CODES.cancel.includes("other"), "cancel locks 'other'");
  assert(
    LOCKED_CODES.reassign.includes("other") && LOCKED_CODES.reassign.includes("owner_reassignment"),
    "reassign locks 'other' and 'owner_reassignment' (the machine-emitted code)",
  );
}

const row = (
  action: ReasonOptionRow["action"],
  code: string,
  label: string,
  sort_order: number,
  active = true,
  locked = false,
): ReasonOptionRow => ({ action, code, label, sort_order, active, locked });

// --- resolveReasonOptions: store rows -> {active, all}, sorted, default fallback ---
{
  const rows: ReasonOptionRow[] = [
    row("cancel", "b_code", "B", 1),
    row("cancel", "a_code", "A", 0),
    row("cancel", "retired_code", "Old", 2, false),
    row("cancel", "other", "Other", 3, true, true),
  ];
  const res = resolveReasonOptions(rows);
  assert(
    res.cancel.all.map((o) => o.code).join(",") === "a_code,b_code,retired_code,other",
    "all: every row for the action, sorted by sort_order (incl. retired)",
  );
  assert(
    res.cancel.active.map((o) => o.code).join(",") === "a_code,b_code,other",
    "active: only active rows, retired filtered out, sorted",
  );
  assert(
    res.cancel.active[0].label === "A" && res.cancel.all[2].label === "Old",
    "options carry the stored label",
  );
}
{
  // An action with NO stored rows falls back to the coded default (both all + active).
  const res = resolveReasonOptions([]);
  assert(
    res.reschedule.active.map((o) => o.code).join(",") ===
      RESCHEDULE_REASONS.map((o) => o.code).join(","),
    "empty store -> reschedule falls back to coded default (active)",
  );
  assert(
    res.reschedule.all.map((o) => o.code).join(",") ===
      RESCHEDULE_REASONS.map((o) => o.code).join(","),
    "empty store -> reschedule falls back to coded default (all)",
  );
  assert(
    res.cancel.active.length === CANCEL_REASONS.length &&
      res.reassign.active.length === REASSIGN_REASONS.length,
    "empty store -> cancel + reassign also fall back to their coded defaults",
  );
}
{
  // A store populated for ONE action does not affect an unpopulated action.
  const res = resolveReasonOptions([row("cancel", "only", "Only", 0)]);
  assert(res.cancel.active.length === 1 && res.cancel.active[0].code === "only", "populated cancel uses store");
  assert(
    res.reschedule.active.map((o) => o.code).join(",") === RESCHEDULE_REASONS.map((o) => o.code).join(","),
    "unpopulated reschedule still falls back to coded default",
  );
}

// --- loadReasonOptions: never throws; store rows win, errors -> coded defaults ---
{
  const rows: ReasonOptionRow[] = [
    row("cancel", "only", "Only", 0),
    row("cancel", "other", "Other", 1, true, true),
  ];
  const res = await loadReasonOptions(async () => ({ data: rows, error: null }));
  assert(res.cancel.active.map((o) => o.code).join(",") === "only,other", "store rows drive the resolved options");
}
{
  // A read error must NOT throw and must fall back to coded defaults.
  let threw = false;
  let res;
  try {
    res = await loadReasonOptions(async () => ({ data: null, error: { message: "boom" } }));
  } catch {
    threw = true;
  }
  assert(!threw, "a read error does not throw");
  assert(
    res!.cancel.active.length === CANCEL_REASONS.length,
    "a read error falls back to the coded default taxonomy",
  );
}
{
  // A thrown reader (e.g. network) must also degrade, not propagate.
  let threw = false;
  let res;
  try {
    res = await loadReasonOptions(async () => {
      throw new Error("network down");
    });
  } catch {
    threw = true;
  }
  assert(!threw, "a thrown reader does not propagate");
  assert(res!.reschedule.active.length === RESCHEDULE_REASONS.length, "a thrown reader degrades to defaults");
}

// --- parseReasonOptionsForm: submitted rows -> complete store set + errors ---
const emptyActions = (): ReasonOptionsFormInput => ({
  reschedule: [],
  cancel: [],
  reassign: [],
});

{
  // A brand-new row derives a code from its label; sort_order follows submit order.
  const input = emptyActions();
  input.cancel = [
    { code: "", label: "Cost concerns", active: true },
    { code: "no_longer_interested", label: "No longer interested", active: true },
    { code: "other", label: "Other", active: true },
  ];
  const { rows, errors } = parseReasonOptionsForm(input);
  assert(errors.length === 0, "a valid form has no errors");
  const cancel = rows.filter((r) => r.action === "cancel");
  const added = cancel.find((r) => r.label === "Cost concerns")!;
  assert(added.code === "cost_concerns", "new row code is slugged from the label");
  assert(added.sort_order === 0, "sort_order follows submitted order");
  assert(cancel.find((r) => r.code === "no_longer_interested")!.sort_order === 1, "existing row keeps position");
}
{
  // A blank label is rejected; a label with no sluggable chars is rejected.
  const input = emptyActions();
  input.cancel = [
    { code: "", label: "   ", active: true },
    { code: "", label: "!!!", active: true },
    { code: "other", label: "Other", active: true },
  ];
  const { errors } = parseReasonOptionsForm(input);
  assert(errors.length >= 2, "blank label and unslug­gable label both error");
}
{
  // A label over the max length is rejected.
  const input = emptyActions();
  input.cancel = [
    { code: "", label: "x".repeat(REASON_LABEL_MAX + 1), active: true },
    { code: "other", label: "Other", active: true },
  ];
  const { errors } = parseReasonOptionsForm(input);
  assert(errors.length >= 1, "an over-long label errors");
}
{
  // Two new rows with the same label get distinct codes (collision-suffixed).
  const input = emptyActions();
  input.cancel = [
    { code: "", label: "Duplicate", active: true },
    { code: "", label: "Duplicate", active: true },
    { code: "other", label: "Other", active: true },
  ];
  const { rows } = parseReasonOptionsForm(input);
  const codes = rows.filter((r) => r.action === "cancel" && r.label === "Duplicate").map((r) => r.code).sort();
  assert(codes.join(",") === "duplicate,duplicate_2", "same-label new rows get unique codes");
}
{
  // A locked row can never be retired, even if the form marks it inactive.
  const input = emptyActions();
  input.cancel = [
    { code: "no_longer_interested", label: "No longer interested", active: false },
    { code: "other", label: "Other", active: false },
  ];
  const { rows } = parseReasonOptionsForm(input);
  const cancel = rows.filter((r) => r.action === "cancel");
  assert(cancel.find((r) => r.code === "other")!.active === true, "locked 'other' stays active despite the form");
  assert(cancel.find((r) => r.code === "other")!.locked === true, "locked flag preserved");
  assert(cancel.find((r) => r.code === "no_longer_interested")!.active === false, "a non-locked row can be retired");
}
{
  // A missing locked row is injected (form tampering / stale form defense).
  const input = emptyActions();
  input.reassign = [{ code: "coverage", label: "Coverage", active: true }];
  const { rows } = parseReasonOptionsForm(input);
  const reassign = rows.filter((r) => r.action === "reassign");
  assert(reassign.some((r) => r.code === "other" && r.locked && r.active), "missing locked 'other' re-injected");
  assert(
    reassign.some((r) => r.code === "owner_reassignment" && r.locked && r.active),
    "missing locked 'owner_reassignment' re-injected",
  );
}
{
  // A new row may not collide with a locked code (e.g. label "Other").
  const input = emptyActions();
  input.cancel = [
    { code: "", label: "Other", active: true },
    { code: "other", label: "Other", active: true },
  ];
  const { rows } = parseReasonOptionsForm(input);
  const cancel = rows.filter((r) => r.action === "cancel");
  const newRow = cancel.find((r) => !r.locked && r.label === "Other")!;
  assert(newRow.code === "other_2", "a new row whose slug collides with a locked code is suffixed");
}

// --- resolveEditorRows: full rows per action for the admin editor ---
{
  const rows: ReasonOptionRow[] = [
    row("cancel", "b_code", "B", 1),
    row("cancel", "a_code", "A", 0),
    row("cancel", "other", "Other", 2, true, true),
  ];
  const res = resolveEditorRows(rows);
  assert(
    res.cancel.map((r) => r.code).join(",") === "a_code,b_code,other",
    "editor rows sorted by sort_order, incl. locked",
  );
  assert(res.cancel[2].locked === true, "carries the locked flag for the editor to disable controls");
}
{
  // Empty store -> seeded coded defaults as full rows, with locked flags set.
  const res = resolveEditorRows([]);
  assert(res.cancel.some((r) => r.code === "other" && r.locked), "empty store seeds 'other' as locked");
  assert(
    res.reassign.some((r) => r.code === "owner_reassignment" && r.locked),
    "empty store seeds 'owner_reassignment' as locked for reassign",
  );
  assert(
    res.reschedule.map((r) => r.code).join(",") === RESCHEDULE_REASONS.map((o) => o.code).join(","),
    "empty store seeds the coded reschedule defaults in order",
  );
}

// --- coerceReasonOptionsForm: untrusted JSON payload -> safe form input ---
{
  const raw = {
    reschedule: [{ code: "schedule_conflict", label: "Schedule conflict", active: true }],
    cancel: [{ code: "", label: "New one", active: false }],
    reassign: [],
  };
  const input = coerceReasonOptionsForm(raw);
  assert(input.reschedule.length === 1 && input.reschedule[0].code === "schedule_conflict", "keeps valid rows");
  assert(input.cancel[0].active === false, "preserves the active flag");
}
{
  // Junk shapes are coerced safely, never throw: non-string code/label -> "",
  // missing arrays -> [], non-boolean active -> false.
  const input = coerceReasonOptionsForm({
    cancel: [{ code: 5, label: null, active: "yes" }, "nope", null],
  });
  assert(input.cancel[0].code === "" && input.cancel[0].label === "", "non-string code/label coerced to empty");
  assert(input.cancel[0].active === false, "non-boolean active coerced to false");
  assert(input.cancel.length === 1, "non-object rows dropped");
  assert(Array.isArray(input.reschedule) && input.reschedule.length === 0, "missing action -> empty array");
}
{
  // A totally malformed payload (not an object) yields all-empty, never throws.
  const input = coerceReasonOptionsForm("garbage");
  assert(
    input.reschedule.length === 0 && input.cancel.length === 0 && input.reassign.length === 0,
    "a non-object payload -> all actions empty",
  );
}

finish();
