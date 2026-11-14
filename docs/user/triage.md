# Triage an issue

Triage lets your own coding agent investigate a LastCode problem. The agent
reads the machine's logs and state, checks the LastCode source for the version
where the problem happened, looks for known issues, and can help you report it
on LastCode's issue tracker. It reads your database without changing it, asks
before it applies a fix or posts anything, and leaves secrets and private
machine details out of what it posts.

The agent asks which version, device, and app the problem happened on. That
can differ from the machine you run triage on, so tell it if the problem was on
another computer, a remote server, your phone, or a build you have since
updated.

## In the app

Open the command palette and choose **Triage an issue**. A new thread with no
project opens, with the triage playbook linked in the message. Choose any
provider, describe what went wrong after the link, and send. LastCode gets the
source for the server's version while you write.

Triage runs on the machine of the thread or draft that you have open. With
nothing open, it uses your primary machine if that supports triage, or else the
first connected machine that does. The new thread shows the machine name, and on
mobile the palette row shows it before you start. If you change the machine
before you send, triage moves to that machine. The agent runs inside that
LastCode server, so it gives you any restart steps and does not do them itself.

## In a terminal

If the app does not start, or triage does not work in the app, run:

```sh
~/.lastcode/bin/t3 triage --base-dir "$HOME/.lastcode"
```

The installed LastCode app creates this launcher the first time it opens. If you
use a custom `T3CODE_HOME`, run `bin/t3 triage --base-dir "$PWD"` from that folder instead.
Installing the **t3 command** from **Settings → About** also lets you run
`t3 triage --base-dir "$HOME/.lastcode"`. If upstream T3 Code's `t3` is also on your `PATH`, use the full
launcher path: `npx t3 triage` and upstream's `t3` investigate upstream T3 Code
and report to its tracker, not LastCode's.

It starts Claude Code or Codex in your terminal with the same instructions.
Use `--agent codex` or `--agent claude` to choose one, and `--model <model>` to
choose its model. If neither agent is installed, it saves the prompt and
machine context so you can use another coding agent.
