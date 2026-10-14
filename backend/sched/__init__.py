"""Scheduled tasks: built-in jobs that run on a schedule ("every Monday at
09:00, the stock report to Telegram"; "every night, the prices read again").

    cron.py     schedules: the friendly forms, cron, words, the next times
    kinds.py    the task types, their inputs and what each does
    core.py     tasks and runs in the database, and the scheduler loop
    runner.py   one run, in a process of its own
    deliver.py  where a result goes: the notification centre, Telegram, Files
    api.py      the Tasks tab's routes (/api/scheduled)

The plan, with the reasons, is in the agents' notes (SCHEDULED-TASKS-PLAN.md).
"""
