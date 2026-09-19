"""JSON-lines task bridge between the Node runner and AndroidWorld.

The runner (`run.ts`) spawns this script and speaks one JSON object per line
on stdin, reading one JSON object per line on stdout:

  {"id": 1, "method": "hello", "params": {...}}
  {"id": 1, "ok": true, ...}

Methods: `hello`, `list_tasks`, `init_task`, `score_task`,
`teardown_task`, `submit_answer`, `quit`.

AndroidWorld stays authoritative: task objects come from its registry and
scoring uses the real `TaskEval.is_successful` validators. This module only
adapts the emulator-backed environment (`env_launcher.load_and_setup_env`)
to a task-at-a-time service. The `android_world` package is imported lazily
so `--help`-style misuse still prints an actionable error when it is missing.

Requires: a running emulator (see the benchmark guide) and an installed
`android_world` checkout (`python3 -c "import android_world"`).
"""

import json
import random
import sys
import traceback

_state = {
    "env": None,
    "registry": None,
    "ir_tasks": frozenset(),
    "current": {},
}


def _fail(message):
  return {"ok": False, "error": message}


def _need_android_world():
  try:
    import android_world  # noqa: F401
  except ImportError as error:
    raise RuntimeError(
        "The `android_world` package is not installed for this Python. "
        'Clone https://github.com/google-research/android_world and run '
        "`pip install -r requirements.txt && python setup.py install`."
    ) from error


def _handle_hello(params):
  _need_android_world()
  from android_world import registry
  from android_world.env import env_launcher

  if _state["env"] is None:
    _state["env"] = env_launcher.load_and_setup_env(
        console_port=int(params.get("console_port", 5554)),
        emulator_setup=bool(params.get("emulator_setup", False)),
        adb_path=params.get("adb_path") or "adb",
        grpc_port=int(params.get("grpc_port", 8554)),
    )
  task_registry = registry.TaskRegistry()
  _state["registry"] = task_registry.get_registry(
      task_registry.ANDROID_WORLD_FAMILY
  )
  _state["ir_tasks"] = frozenset(
      task_registry.get_registry(task_registry.INFORMATION_RETRIEVAL_FAMILY)
  )
  return {
      "ok": True,
      "families": ["android_world"],
      "tasks": len(_state["registry"]),
  }


def _handle_list_tasks(params):
  if _state["registry"] is None:
    return _fail("Call hello before list_tasks.")
  suite = params.get("suite", "android_world")
  if suite != "android_world":
    return _fail(f'Unknown suite "{suite}": expected "android_world".')
  return {"ok": True, "tasks": sorted(_state["registry"].keys())}


def _handle_init_task(params):
  if _state["registry"] is None or _state["env"] is None:
    return _fail("Call hello before init_task.")
  name = params.get("task", "")
  if name not in _state["registry"]:
    return _fail(f'Task "{name}" is not in the android_world registry.')
  seed = params.get("seed")
  if seed is not None:
    random.seed(seed)

  task_type = _state["registry"][name]
  task_params = task_type.generate_random_params()
  task = task_type(task_params)
  env = _state["env"]
  env.reset(go_home=True)
  task.initialize_task(env)
  _state["current"][name] = task
  return {
      "ok": True,
      "task": name,
      "goal": str(task.goal),
      "task_type": "qa" if name in _state["ir_tasks"] else "action",
      "complexity": float(task.complexity),
  }


def _handle_submit_answer(params):
  if _state["env"] is None:
    return _fail("Call hello before submit_answer.")
  # Information-retrieval validators read the agent answer from
  # `env.interaction_cache`, which the built-in agents fill in through the
  # ANSWER action. The Midscene agent answers through `aiAct` instead, so the
  # runner forwards its outcome here before scoring.
  _state["env"].interaction_cache = str(params.get("answer", ""))
  return {"ok": True}


def _handle_score_task(params):
  if _state["env"] is None:
    return _fail("Call hello before score_task.")
  name = params.get("task", "")
  task = _state["current"].get(name)
  if task is None:
    return _fail(f'Task "{name}" was not initialized: call init_task first.')
  score = float(task.is_successful(_state["env"]))
  return {"ok": True, "task": name, "score": score, "passed": score > 0.5}


def _handle_teardown_task(params):
  if _state["env"] is None:
    return _fail("Call hello before teardown_task.")
  name = params.get("task", "")
  task = _state["current"].pop(name, None)
  if task is None:
    return _fail(f'Task "{name}" was not initialized: call init_task first.')
  task.tear_down(_state["env"])
  return {"ok": True, "task": name}


_HANDLERS = {
    "hello": _handle_hello,
    "list_tasks": _handle_list_tasks,
    "init_task": _handle_init_task,
    "submit_answer": _handle_submit_answer,
    "score_task": _handle_score_task,
    "teardown_task": _handle_teardown_task,
}


def _dispatch(request):
  method = request.get("method", "")
  params = request.get("params", {}) or {}
  if method == "quit":
    return {"ok": True}, True
  handler = _HANDLERS.get(method)
  if handler is None:
    return _fail(f'Unknown method "{method}".'), False
  try:
    return handler(params), False
  except Exception as error:  # noqa: BLE001 - errors cross the stdio boundary as JSON.
    traceback.print_exc()
    return _fail(f"{method} failed: {error}"), False


def main():
  for line in sys.stdin:
    line = line.strip()
    if not line:
      continue
    try:
      request = json.loads(line)
    except json.JSONDecodeError as error:
      sys.stdout.write(json.dumps({"id": None, "ok": False, "error": f"Bad JSON: {error}"}) + "\n")
      sys.stdout.flush()
      continue
    response, should_quit = _dispatch(request)
    response["id"] = request.get("id")
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
    if should_quit:
      break


if __name__ == "__main__":
  main()
