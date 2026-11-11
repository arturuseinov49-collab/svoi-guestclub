# Автоматические обновления «Своих»

## Схема и граница доверия

GitHub Actions проверяет код, собирает Mini App и публикует **публичный неизменяемый Release только при push в main**. Pull request и ручной workflow_dispatch проходят проверки без публикации. VPS примерно каждые пять минут читает публичный API и скачивает assets без GitHub-токена. Telegram, POS, база и `/etc/svoi/svoi.env` остаются на VPS и не входят в CI или архив приложения.

Доверенными являются владельцы репозитория, сопровождающие main и определение workflow. Публичное чтение репозитория не даёт права публикации. Не выдавайте `contents:write` посторонним workflow или непроверенным actions, ограничьте доступ к main и защищайте аккаунты владельцев. Проверки manifest и SHA256 не заменяют доверие к этому кругу. Установка приложения с правами `svoi` позволяет ему использовать рабочие секреты: изменение доверенного исходного кода требует такой же ответственности, как ручной релиз.

Обязательное условие — **GitHub immutable releases включены для репозитория до первой публикации**. Updater требует `immutable: true`, автора `github-actions[bot]`, точный repository/tag/commit, digest GitHub asset, все файловые SHA256 и успешный завершённый run `.github/workflows/ci.yml` с `event=push`, `head_branch=main` и тем же SHA. Пока publish-job ещё выполняется, установка откладывается до следующей проверки. Релиз не перезаписывается; исправление выпускается новым commit.

Сервер запускает только фиксированный root-owned updater из `/usr/local/lib/svoi`. Файлы из скачанного релиза никогда не исполняются от root. Приложение и бот работают под `svoi`. Root updater и systemd units не обновляются через приложение; изменение этих компонентов требует повторной ручной установки проверенного bootstrap.

## Предпосылки

- Linux с systemd, Python 3.10+, Node.js 22.22.0+; CI использует Node 22.22.0.
- Существующие `svoi-web.service` и `svoi-bot.service`, оба `User=svoi`, с прежним EnvironmentFile. Caddy и остальные сервисы установщик не меняет.
- `/opt/svoi/current` — symlink на root-owned каталог внутри `/opt/svoi/releases`.
- Рабочая SQLite `/var/lib/svoi/svoi.sqlite`, `PRAGMA user_version=2`.
- HTTPS-доступ к GitHub API и release assets. API без авторизации ограничен; обычный poll использует один запрос, новый релиз — дополнительные запросы manifest и workflow. HTTP 403/429/5xx и сетевые сбои не останавливают текущую версию и повторяются следующим таймером.

## Что публикуется

`release.json` содержит формат, repository, полный commit SHA, время сборки, workflow run ID, схему БД, минимальную Node, имя/размер/SHA256 архива и список файлов с их размерами/SHA256. Архив `svoi-<SHA40>.tar.gz` содержит только `dist/`, `server/*.mjs`, `bot/*.mjs` и `version.json`. Секреты, исходники установщика, SQLite, backups и node_modules не входят в него. В payload нет npm-зависимостей серверного времени исполнения; они нужны только при сборке фронтенда.

Пути архива проверяются по manifest; ссылки, устройства, sparse-файлы, дубликаты, скрытые/абсолютные/выходящие наружу пути запрещены. Не используются `extractall`, tar ownership/modes или shell-команды из release. После проверки права кода: root-owned каталоги `0755`, файлы `0644`.

## Одноразовая установка

Сначала дождитесь успешной Linux CI для конкретного SHA. Проверьте bootstrap-архив и его SHA256 по переданному manifest. Распакуйте его в отдельный root-only каталог, например `/root/svoi-bootstrap-<SHA>`, и прочитайте скрипт перед выполнением. Не запускайте root-скрипт из изменяемого `/opt/svoi/current` или произвольной ссылки на main.

```bash
bash /root/svoi-bootstrap-<SHA>/install-autodeploy.sh OWNER/REPOSITORY
systemctl cat svoi-update.service svoi-update.timer svoi-backup.service
systemctl enable --now svoi-update.timer
systemctl start svoi-update.service
journalctl -u svoi-update.service -n 60 --no-pager
```

Без аргумента `--enable` установщик только устанавливает конфигурацию и units. Повторная установка не заменяет имеющийся другой repository в конфиге. Она не меняет `.env`, базу, Caddy или настройки приложений. Для существующего ежедневного backup-unit создаётся drop-in: root запускает фиксированный updater с `--backup-only`, а не `backup.py` внутри активного приложения.

Установленные пути:

| Путь | Назначение |
| --- | --- |
| `/usr/local/lib/svoi/update.py`, `release_contract.py` | Проверенный код управления, root-owned |
| `/etc/svoi/autodeploy.json` | Только публичный `repository`, без токена |
| `/var/lib/svoi-deploy/status.json` | Атомарный журнал active/pending/failed |
| `/var/lib/svoi-deploy/backups/` | Копии SQLite, root-only и вне writable каталога приложения |
| `/opt/svoi/.staging/<SHA>-<UUID>` | Закрытый временный каталог текущей попытки |
| `/opt/svoi/releases/<SHA>` | Проверенный код релиза |

## Обновление и восстановление

Перед переключением создаётся согласованная SQLite-копия через backup API, проверяется `integrity_check`. Журнал `pending` сохраняется и синхронизируется на диск. Затем останавливаются только web/bot, атомарно заменяется symlink и запускаются оба процесса. API должен пять раз подряд подтвердить app, database, schema и точный commit; оба systemd-сервиса должны быть active. Проверка бота здесь подтверждает живой процесс, а не доставку реального сообщения в Telegram.

При неуспехе возвращается прежний symlink и запускается прежний код. **База никогда автоматически не восстанавливается из backup**, поэтому новые визиты и операции не теряются от отката кода. После внезапной остановки updater или VPS незавершённый `pending` восстанавливается перед чтением новых релизов. Если обнаружена неизвестная схема БД, сервисы остаются остановленными, журнал сохраняется для ручного решения; старый код не открывает и не понижает такую базу.

После остановки writers схема проверяется по закрытой временной копии DB+WAL: SQLite создаёт SHM только у копии в private staging. Исходный каталог БД остаётся read-only для updater. Режим immutable для чтения оригинала не используется: он мог бы пропустить более новую схему в оставшемся WAL. Единственный writer SQLite — web; бот пишет только свой offset, ежедневный backup читает SQLite. Перед такой проверкой systemd должен подтвердить остановку процессов. Ошибка копирования оставляет `pending` и остановленные сервисы для следующей проверки или ручного решения.

Автоматическая миграция схемы выключена: принимается только schema 2. Изменение схемы, формата бизнес-данных или несовместимое изменение поведения требует отдельного плана совместимости и ручного этапа. Одинаковый номер схемы сам по себе не доказывает совместимость — это ответственность ревью исходного кода.

Повреждённый архив/неудачный запуск запоминается как `failedReleaseId` и не перезапускается каждые пять минут. Исправляйте новым commit и новым release. Временная ошибка сети не помечает commit плохим. Удаляется только собственный UUID staging текущей попытки, после проверки ancestry/owner и без перехода по symlink. Остальные staging, предыдущие releases, данные и backups автоматически не удаляются. При нехватке места updater отказывается от установки; оператор регулярно контролирует диск и отдельно утверждает политику хранения. Копии на том же VPS не защищают от потери VPS — внешнее хранилище настраивается отдельно.

## Контроль и пауза

```bash
systemctl status svoi-update.timer svoi-web svoi-bot
systemctl list-timers svoi-update.timer
cat /var/lib/svoi-deploy/status.json
curl --fail http://127.0.0.1:8081/api/health
```

В health возвращаются только публичные commit/repository/builtAt и фактический databaseSchema; секретов там нет. Первоначальная вручную установленная версия может не иметь version.json: rollback к ней проверяет базовый health. Все новые CI-релизы проверяются по точному SHA.

Чтобы приостановить будущие попытки:

```bash
touch /etc/svoi/autodeploy.disabled
systemctl stop svoi-update.timer
```

Уже выполняющийся updater может безопасно завершить текущую попытку; проверьте его status перед ручной работой. Не редактируйте `status.json` во время выполнения. Для возобновления уберите флаг после проверки состояния и включите timer. Если оборвать работающий updater, на следующем запуске сработает pending recovery. Ручное восстановление БД — отдельная операция с сохранением текущего состояния, а не часть автодеплоя.

## Проверки

```bash
python3 -m unittest discover -s tests/deploy -v
bash -n deploy/install-autodeploy.sh
npm run lint
npm run typecheck
npm test
npm run build
```

Тесты проверяют traversal/links/devices, digest и schema, provenance, неполную загрузку, SQLite WAL backup, неправильный health commit, atomic code rollback с сохранением новых записей БД и recovery после прерывания. Проверки symlink/permissions/flock должны реально пройти на Linux, а не только быть пропущены Windows-хостом. Успешная CI не равна включённому production-таймеру: установку, первый реальный release и внешний health нужно подтвердить отдельно.

Официальные справочники: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases), [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [gh release create](https://cli.github.com/manual/gh_release_create), [Python tarfile security](https://docs.python.org/3/library/tarfile.html#extraction-filters), [SQLite backup](https://www.sqlite.org/backup.html), [systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).
