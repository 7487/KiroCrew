"""The operator override for the unrecoverable-shell deny-by-default refusal.

``HookManager.on_tool_call`` refuses a shell tool call whose command string could
not be recovered from the provider payload, because evaluating the untrusted
title alone is the bypass that gate closes. That refusal has a false-positive
history (a payload shape a build does not recognize yields no command even for an
ordinary call), so an operator can suppress it — and ONLY it — from the keystone
opt-out state.

Pinned here: default off; the refusal stands while off; suppression falls through
to the title-only checks rather than skipping the gate; every suppression is
audited, and an unauditable suppression re-denies; the sibling truncated-argument
refusal is deliberately NOT covered by the switch; and a malformed value fails
safe to off.
"""

from __future__ import annotations

import pytest

from kiro_crew.hooks import TOOL_DENY, HookManager, HooksConfig


def _manager(**denied_commands) -> HookManager:
    return HookManager(HooksConfig.from_dict({"denied_commands": denied_commands}))


_UNVERIFIED = "could not be verified for security policy"


def test_default_is_off() -> None:
    assert HooksConfig.from_dict({}).denied_commands_allow_unverified_shell is False


def test_refusal_stands_while_off() -> None:
    res = _manager().on_tool_call("Running a command", is_shell=True, command=None)
    assert res.action == TOOL_DENY
    assert _UNVERIFIED in (res.reason or "")


def test_switch_suppresses_the_refusal(monkeypatch) -> None:
    audited: list[dict] = []
    _patch_sel(monkeypatch, audited)
    res = _manager(allow_unverified_shell=True).on_tool_call(
        "Running a command", is_shell=True, command=None
    )
    assert res.action != TOOL_DENY or _UNVERIFIED not in (res.reason or "")
    # Every suppression is audited, not just the flag flip.
    assert len(audited) == 1
    assert audited[0]["outcome"] == "delegated"
    assert "allow_unverified_shell" in audited[0]["error"]


def test_suppression_still_evaluates_the_title(monkeypatch) -> None:
    """Suppressing the refusal degrades to the title-only checks — it does not
    skip the gate. A title naming a sensitive path must still be refused."""
    _patch_sel(monkeypatch, [])
    res = _manager(allow_unverified_shell=True).on_tool_call(
        "cat ~/.aws/credentials", is_shell=True, command=None
    )
    assert res.action == TOOL_DENY
    assert _UNVERIFIED not in (res.reason or "")


def test_unauditable_suppression_re_denies(monkeypatch) -> None:
    """Audit-or-deny: an unaudited suppression is worse than a refusal."""
    import kiro_crew.hooks as hooks_mod

    class _Boom:
        def log_tool_invocation(self, **kwargs):
            raise RuntimeError("sel is down")

    monkeypatch.setattr(hooks_mod, "sel", lambda: _Boom())
    res = _manager(allow_unverified_shell=True).on_tool_call(
        "Running a command", is_shell=True, command=None
    )
    assert res.action == TOOL_DENY
    assert _UNVERIFIED in (res.reason or "")


@pytest.mark.parametrize("junk", ["maybe", "", 1, {}, [], None])
def test_malformed_value_fails_safe_to_off(junk) -> None:
    cfg = HooksConfig.from_dict({"denied_commands": {"allow_unverified_shell": junk}})
    assert cfg.denied_commands_allow_unverified_shell is False


def test_switch_does_not_cover_the_truncated_argument_refusal(monkeypatch) -> None:
    """The sibling deny-by-default refusal is deliberately NOT switchable.

    Suppressing it would mean trusting a PARTIAL sensitive-path scan as complete,
    on the keystone the governance model leans on — a hole, not a convenience.
    """
    import kiro_crew.hooks as hooks_mod

    class _Truncated(list):
        truncated = True

    monkeypatch.setattr(hooks_mod, "target_paths", lambda params: _Truncated())
    _patch_sel(monkeypatch, [])
    res = _manager(allow_unverified_shell=True).on_tool_call(
        "edit", tool_kind="read", raw_params={"path": "/tmp/x"}
    )
    assert res.action == TOOL_DENY
    assert "too large to verify" in (res.reason or "")


def test_state_round_trips_through_the_keystone_object() -> None:
    cfg = HooksConfig.from_dict({"denied_commands": {"allow_unverified_shell": True}})
    assert cfg.denied_commands_state()["allow_unverified_shell"] is True


def test_the_suppression_audit_is_written_synchronously(monkeypatch) -> None:
    """``critical=True`` is what makes audit-or-deny reachable at all.

    ``SecurityEventLog.log`` only ENQUEUES a non-critical event and its
    writer thread swallows-and-warns a filesystem failure, so without
    ``critical=True`` the ``except -> deny`` branch above is dead for the very
    failure it exists to catch: the suppressed refusal would run with no
    durable record.  ``test_unauditable_suppression_re_denies`` cannot catch a
    regression here — its mock raises synchronously, which passes either way —
    so the flag itself has to be pinned.
    """
    audited: list[dict] = []
    _patch_sel(monkeypatch, audited)
    _manager(allow_unverified_shell=True).on_tool_call(
        "Running a command", is_shell=True, command=None
    )
    assert audited[0]["critical"] is True


def test_heartbeat_scoping_does_not_carry_the_override() -> None:
    """The override WIDENS, so it must not survive into a heartbeat session.

    The sibling denied-command fields are carried because a deny can only
    narrow what runs unattended.  This one suppresses a refusal, so carrying it
    would admit unverifiable commands into the one surface that is narrowed to
    an allowlist precisely because nobody is watching.
    """
    from kiro_crew.slack.gateway import _build_heartbeat_hooks

    user = _manager(allow_unverified_shell=True, disabled_ids=["git-publish-push-force"])
    assert user._config.denied_commands_allow_unverified_shell is True

    scoped = _build_heartbeat_hooks(user)
    assert scoped._config.denied_commands_allow_unverified_shell is False
    # The narrowing siblings DO carry over — this is a targeted drop, not a reset.
    assert scoped._config.denied_commands_disabled_ids == ["git-publish-push-force"]


def _patch_sel(monkeypatch, sink: list) -> None:
    import kiro_crew.hooks as hooks_mod

    class _Sel:
        def log_tool_invocation(self, **kwargs):
            sink.append(kwargs)

    monkeypatch.setattr(hooks_mod, "sel", lambda: _Sel())
