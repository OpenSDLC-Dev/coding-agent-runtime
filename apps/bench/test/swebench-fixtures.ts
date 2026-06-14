// Synthetic SWE-bench fixtures. These are FABRICATED (made-up repos, fake 40-char hex SHAs, invented
// issue text) — deliberately NOT copied from the real dataset, so no copyrighted issue text or gold
// patches enter the repo. They exist only to exercise our parsing/shape code deterministically.

// A dataset file as the operator would download it: a JSON array carrying the full SWE-bench columns.
// Our slim schema reads only instance_id/repo/base_commit/problem_statement and STRIPS the rest, so
// the extra fields here prove the full file parses unchanged.
export const SYNTHETIC_DATASET = JSON.stringify([
  {
    instance_id: "acme__widget-101",
    repo: "acme/widget",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    problem_statement: "Widget.size returns the wrong value for an empty widget.",
    FAIL_TO_PASS: '["tests/test_widget.py::test_size_empty"]',
    PASS_TO_PASS: '["tests/test_widget.py::test_size_basic"]',
    patch: "diff --git a/widget.py b/widget.py\n@@ gold @@",
    test_patch: "diff --git a/tests/test_widget.py b/tests/test_widget.py\n@@ test @@",
    version: "1.0",
    environment_setup_commit: "fedcba9876543210fedcba9876543210fedcba98",
    hints_text: "",
    created_at: "2023-01-15T12:34:56Z",
  },
  {
    instance_id: "acme__gadget-7",
    repo: "acme/gadget",
    base_commit: "89abcdef0123456789abcdef0123456789abcdef",
    problem_statement: "Gadget.connect throws when the port is already bound.",
    FAIL_TO_PASS: '["tests/test_gadget.py::test_connect_bound"]',
    PASS_TO_PASS: "[]",
    patch: "diff --git a/gadget.py b/gadget.py\n@@ gold @@",
    test_patch: "diff --git a/tests/test_gadget.py b/tests/test_gadget.py\n@@ test @@",
    version: "2.3",
  },
]);

// The exact local-harness summary report shape (swebench/harness/reporting.py, schema_version 2),
// with fabricated ids matching the synthetic dataset above.
export const SYNTHETIC_DOCKER_REPORT = JSON.stringify({
  total_instances: 2,
  submitted_instances: 2,
  completed_instances: 2,
  resolved_instances: 1,
  unresolved_instances: 1,
  empty_patch_instances: 0,
  error_instances: 0,
  completed_ids: ["acme__widget-101", "acme__gadget-7"],
  incomplete_ids: [],
  empty_patch_ids: [],
  submitted_ids: ["acme__widget-101", "acme__gadget-7"],
  resolved_ids: ["acme__widget-101"],
  unresolved_ids: ["acme__gadget-7"],
  error_ids: [],
  schema_version: 2,
});
