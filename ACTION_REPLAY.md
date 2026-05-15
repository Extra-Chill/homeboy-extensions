# Non-Workspace Action Replay Evidence

## Problem

wp-gym benchmark requires non-workspace action replay evidence. Only workspace diffs are currently captured.

## Solution: Action Replay Manifest

```python
@dataclass
class ActionEvidence:
    id: str
    action_type: str  # file_read, exec, web_fetch, etc.
    target: str
    workspace_relative: bool
    output_hash: str  # SHA256 for verification
    duration_ms: int
    success: bool

@dataclass 
class ReplayManifest:
    run_id: str
    actions: List[ActionEvidence]
    
    def validate(self):
        return all(
            a.output_hash == sha256(json.dumps(a.output_data))
            for a in self.actions
        )

class ActionReplayCollector:
    def __init__(self, workspace_root):
        self.workspace_root = workspace_root
        self.manifest = ReplayManifest(run_id=uuid4(), actions=[])
    
    def record(self, action_type, target, output, duration_ms):
        workspace_rel = target.startswith(self.workspace_root)
        evidence = ActionEvidence(
            id=str(uuid4()),
            action_type=action_type,
            target=target,
            workspace_relative=workspace_rel,
            output_hash=sha256(json.dumps(output)),
            duration_ms=duration_ms,
            success=True
        )
        self.manifest.actions.append(evidence)
        return evidence
```

## Benchmark Validation

```python
def validate_eligibility(manifest):
    non_ws = [a for a in manifest.actions if not a.workspace_relative]
    issues = []
    if not non_ws: issues.append("No non-workspace actions")
    if not manifest.validate(): issues.append("Hash validation failed")
    return {"eligible": len(issues) == 0, "issues": issues}
```
