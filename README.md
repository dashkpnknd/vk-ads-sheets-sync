# VK Ads -> Google Sheets Sync

Локальная заготовка сервера/синхронизатора для ежедневной записи статистики VK Рекламы в уже существующие Google Таблицы клиентов.

Основной рабочий путь для текущего процесса: браузерный RPA-робот с сохраненными VK-сессиями. API на каждый кабинет оставлен как запасной вариант, потому что новые кабинеты появляются постоянно.

## Что уже работает

- Доступ к Google Sheets через service account.
- Чтение структуры клиентской таблицы.
- Поиск нужной даты в первой строке.
- Поиск строк метрик по названиям:
  - `Кол-во лидов`
  - `Цена за лид`
  - `Цена за лид с учетом бонусов`
  - `Расходы`
  - `Расходы + НДС`
- Расчет:
  - цена лида = расход / лиды
  - расходы + НДС = расход * 1.22
  - цена лида с учетом бонусов = цена лида * 0.5
- Тестовая запись в Google Sheets через mock-статистику.
- Парсинг названий кабинетов формата `Проект | Город (номер)`.
- Суммирование нескольких кабинетов одного проекта.
- Ежедневная проверка всех распознанных кабинетов, включая кабинеты с нулевым расходом.

## Основная RPA-схема

```text
VK аккаунты с сохраненной сессией
  -> робот открывает ads.vk.com
  -> обходит все кабинеты аккаунта
  -> берет статистику за вчера
  -> парсит название кабинета
  -> суммирует кабинеты одного проекта
  -> пишет итог в Google-таблицу проекта
```

Служебные шаблоны:

- `config/projects_registry.template.csv` - проект, город, ссылка на Google-таблицу.
- `config/vk_accounts.template.csv` - VK-аккаунты и папки браузерных профилей.
- `config/discovered_cabinets.template.csv` - найденные кабинеты и их статус.

Подробное описание: `docs/rpa-sync-design.md`.

## Текущий рабочий RPA-запуск

Открыть отдельное окно VK-аккаунта, если профиль еще не запущен:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/open_vk_profile.mjs --account-label vk-account-1 --port 9223
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/open_vk_profile.mjs --account-label vk-account-2 --port 9224
```

После ручного входа в VK один раз сессии хранятся в `profiles/`.

Запуск синхронизации за вчера:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/rpa_sync_projects.mjs --config config/rpa.local.json
```

Запуск за конкретную дату для проверки:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/rpa_sync_projects.mjs --config config/rpa.local.json --date 2026-06-18
```

Текущий тестовый реестр проектов: `config/projects.local.csv`.

Текущий реестр найденных кабинетов: `config/discovered_cabinets.local.csv`.

Чтобы добавить новый проект, нужно:

1. Добавить строку в `config/projects.local.csv`: `project_key`, название проекта, город, Google Sheet ID, лист.
2. Выдать доступ на Google-таблицу сервисному аккаунту `vk-ads-sync-bot@vk-ads-sheets-sync.iam.gserviceaccount.com`.
3. Название кабинета VK должно быть в формате `Проект | Город` или `Проект | Город (2)`.

Чтобы добавить новый VK-аккаунт, нужно:

1. Запустить новый профиль через `bin/open_vk_profile.mjs` с новым портом, например `9225`.
2. Войти в VK/ads.vk.com вручную один раз.
3. Добавить аккаунт в `config/rpa.local.json`.

Проверенный результат на 2026-06-18:

- найдено 40 кабинетов в двух VK-аккаунтах;
- по тестовым проектам совпало 7 кабинетов;
- нулевые кабинеты записываются как `zero_spend` и проверяются снова на следующих запусках;
- `Аймоби | Москва` записан в Google Sheets: 9 лидов, 1 186,12 ₽ расход, 1 447,07 ₽ расход + НДС.

## Локальный тестовый конфиг

Текущий тестовый конфиг: `config/clients.local.json`.

Пример боевого конфига: `config/clients.example.json`.

Для каждого клиента/кабинета нужна строка:

```json
{
  "clientName": "Название клиента",
  "spreadsheetId": "google_spreadsheet_id",
  "sheetName": "ВК Таргет Июнь",
  "vkSource": "vk_ads_api",
  "vkAccountLabel": "VK аккаунт 1",
  "vkCabinetName": "Название кабинета",
  "vkCredentialsRef": "vk-account-1-or-cabinet-1"
}
```

Сейчас `vkSource: "mock"` используется только для проверки Google-части без VK API/RPA.

## Запуск теста

Используется встроенный Node.js из Codex runtime:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/*.test.mjs
```

Подготовить отдельную вкладку `Автотест` в тестовой таблице:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/prepare_autotest_sheet.mjs config/clients.local.json
```

Записать mock-статистику за дату:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/sync.mjs --config config/clients.local.json --date 2026-06-18
```

## API-режим как запасной вариант

По ответу поддержки VK:

- Для прямого рекламодателя у каждого кабинета своя пара `client_id` и `client_secret`.
- Для финансовой статистики используется `Statistics`: `GET /api/v2/statistics/{banners|ad_groups|ad_plans|users}/{day|summary}.json`.
- Для клиентов агентства используется `AgencyClients`: `GET /api/v2/agency/clients.json`.

Для live-режима по каждому прямому кабинету нужны:

```text
client_id
client_secret
название кабинета
ссылка на Google-таблицу клиента
название листа
```

В конфиге это выглядит так:

```json
{
  "vkCredentials": {
    "cabinet-1": {
      "clientId": "client_id",
      "clientSecret": "client_secret"
    }
  },
  "clients": [
    {
      "clientName": "Клиент",
      "spreadsheetId": "google_spreadsheet_id",
      "sheetName": "ВК Таргет Июнь",
      "vkSource": "vk_ads_api",
      "vkCabinetName": "Кабинет",
      "vkCredentialsRef": "cabinet-1",
      "vkStatisticsLevel": "ad_groups",
      "vkStatisticsPeriod": "day",
      "vkMetrics": ["spent", "goals"],
      "vkSpendMetric": "spent",
      "vkLeadsMetric": "goals"
    }
  ]
}
```

`spent` подтвержден в документации VK как метрика списаний. Метрику лидов нужно проверить на первом реальном кабинете: в конфиге она пока вынесена как `vkLeadsMetric`, потому что у разных целей рекламного кабинета название метрики результата может отличаться.

## Прод-логика

1. Сервер читает реестр клиентов.
2. Для каждого кабинета получает статистику за вчера.
3. Находит нужную Google-таблицу и лист.
4. Находит колонку даты.
5. Записывает только VK-метрики, не трогая ручные строки продаж/выручки/среднего чека.
6. Логи ошибок пишутся отдельно.

## Агентский режим

Если VK выдаст агентский API-доступ, сначала проверяем список клиентов:

1. Создать локальный файл по образцу `config/vk-agency.example.json`.
2. Вставить агентские `clientId` и `clientSecret`.
3. Запустить:

```bash
/Users/pnkvd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bin/agency_clients.mjs --credentials config/vk-agency.local.json
```

Команда вызывает официальный метод:

```text
GET /api/v2/agency/clients.json
```

После этого по списку клиентов делается реестр:

```text
agency_client_id | client_name | google_spreadsheet_id | sheet_name | status
```

Затем синхронизатор берет статистику через `Statistics` и пишет ее в уже существующие Google-таблицы.

## Роль проекта в системе

Этот проект ежедневно переносит показатели VK Рекламы из нескольких кабинетов в клиентские Google Таблицы. Основной рабочий путь использует браузерные профили, а API оставлен запасным вариантом. `vk-app-price-master` относится к другой задаче — управлению источниками и ценами.
