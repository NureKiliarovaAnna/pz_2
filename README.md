# DAO Voting — практичне заняття № 2

Сценарій **D «Голосування в DAO»**: токен голосу зі знімками балансів, контракт пропозицій і голосування з кворумом і дедлайном, скарбниця, яка виконує ухвалені рішення.

| Контракт | Опис |
|---|---|
| [`DAOToken`](contracts/DAOToken.sol) | ERC-20 + ERC20Votes, 1000 DVT, історичні знімки голосів |
| [`DAOGovernor`](contracts/DAOGovernor.sol) | пропозиції, голосування за знімком, кворум 20 %, дедлайн, виконання, пауза, сторінкове читання |
| [`DAOTreasury`](contracts/DAOTreasury.sol) | ETH, резервування ухвалених виплат, `withdraw()` самим отримувачем, пауза |
| [`IDAOTreasury`](contracts/interfaces/IDAOTreasury.sol) | інтерфейс, через який Governor викликає скарбницю |

Ролі: **ADMIN**, **PROPOSER**, **GUARDIAN** (+ контракт Governor як єдиний, хто резервує виплати).

Документація:
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — ролі, користувацькі сценарії, діаграма станів, схема взаємодії, таблиця функцій;
- [docs/SECURITY.md](docs/SECURITY.md) — навмисна вразливість, атакувальник, результати атаки;
- [docs/GAS.md](docs/GAS.md) — звіт про газ і дві оптимізації «до/після»;
- [docs/slither/README.md](docs/slither/README.md) — запуск Slither.

## Стек

Hardhat 2.29.2 · Solidity 0.8.28 (cancun, optimizer 200) · OpenZeppelin Contracts 5.4.0 · ethers v6 · Chai · solidity-coverage · hardhat-gas-reporter.

## Встановлення

```bash
npm install
cp .env.example .env      # заповніть лише для Sepolia; .env у git не потрапляє
```

## Команди

| Команда | Що робить |
|---|---|
| `npm run compile` | компіляція |
| `npm test` | усі тести |
| `npm run test:security` | лише демонстрація атаки (вразлива та захищена скарбниця) |
| `npm run coverage` | звіт покриття (`coverage/index.html`) |
| `npm run gas:report` | газ по функціях → `docs/gas/gas-report.txt` |
| `npm run gas` | детермінований бенчмарк газу (`GAS_LABEL=name` зберігає JSON) |
| `npm run node` | локальна мережа Hardhat (chainId 31337) |
| `npm run deploy:local` | розгортання в локальну мережу |
| `npm run demo:local` | повний сценарій від імені кількох акаунтів у локальній мережі |
| `npm run deploy:sepolia` | розгортання в Sepolia |
| `npm run verify:sepolia` | верифікація коду на Etherscan |
| `npm run frontend` | вебінтерфейс на http://localhost:5173 |

## Параметри розгортання

Скрипт [`scripts/deploy.js`](scripts/deploy.js) бере параметри зі змінних оточення (`.env`); ключів і адрес у коді немає. Порожні адреси = адреса розгортальника.

| Змінна | Значення |
|---|---|
| `TOKEN_HOLDER` | хто отримує 1000 DVT |
| `ADMIN_ADDRESS`, `PROPOSER_ADDRESS`, `GUARDIAN_ADDRESS` | власники ролей |
| `VOTING_PERIOD` | тривалість голосування, 60 … 2 592 000 с (типово 300) |
| `INITIAL_DEPOSIT_ETH` | скільки ETH одразу внести у скарбницю |
| `TOKEN_DISTRIBUTION` | `0xАдреса:кількість,...` — роздати DVT після розгортання |

Скрипт зберігає `deployments/<network>.json` і генерує `frontend/config.js` (адреси + ABI).

## Локальна демонстрація

```bash
# термінал 1
npm run node

# термінал 2 (bash; у PowerShell задайте змінні через $env:NAME="...")
VOTING_PERIOD=300 INITIAL_DEPOSIT_ETH=5 \
TOKEN_DISTRIBUTION="0x70997970C51812dc3A010C7d01b50e0d17dc79C8:400,0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC:200" \
npm run deploy:local

npm run demo:local      # сценарій у консолі
npm run frontend        # або через браузер
```

MetaMask для локальної мережі: додайте мережу `http://127.0.0.1:8545`, chainId `31337`, і імпортуйте тестові акаунти Hardhat #0 (ADMIN/PROPOSER/GUARDIAN), #1 і #2 (голосуючі). Ключі виводить `npm run node`; це публічно відомі тестові ключі, використовувати їх у справжніх мережах не можна. Після перезапуску вузла в MetaMask виконайте *Settings → Advanced → Clear activity tab data*.

У локальній мережі на сторінці є кнопки «+1 хв / +5 хв / +1 год» для перемотування часу до дедлайну.

## Sepolia

1. Заповніть у `.env`: `SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY` (окремий тестовий гаманець), `ETHERSCAN_API_KEY`, а також `VOTING_PERIOD`, `INITIAL_DEPOSIT_ETH`, `TOKEN_DISTRIBUTION` (адреса другого акаунта).
2. Отримайте тестовий ETH у крані Sepolia.
3. `npm run deploy:sepolia`, потім `npm run verify:sepolia`.
4. `npm run frontend` і перемкніть MetaMask на Sepolia.

## Вебінтерфейс

`frontend/` — статична сторінка (HTML + ethers v6, без збирання):
- підключення MetaMask і перевірка мережі з кнопкою перемикання;
- стан акаунта (DVT, сила голосу, делегат, ролі), скарбниці та пропозицій посторінково;
- делегування, створення пропозицій, голосування, виконання, отримання виплати, депозит, пауза;
- статус кожної транзакції: підпис → очікує → підтверджено / помилка;
- автооновлення за подіями контрактів і новими блоками;
- зрозумілі повідомлення українською для всіх власних помилок контрактів, зокрема тих, що виникають у скарбниці під час `execute`.

## Тести і покриття

133 тести: [`test/DAO.test.js`](test/DAO.test.js), [`test/EdgeCases.test.js`](test/EdgeCases.test.js), [`test/Security.test.js`](test/Security.test.js).

| Контракт | Рядки | Гілки |
|---|---:|---:|
| DAOToken | 100 % | 100 % |
| DAOGovernor | 100 % | 98,61 % |
| DAOTreasury | 100 % | 97,62 % |
| Усього | 98,43 % | 96,84 % |

## Структура

```
contracts/            основні контракти та інтерфейс
contracts/security/   навмисно вразлива копія та атакувальник (лише тести)
contracts/test/       тестові помічники TreasuryCaller, RejectingRecipient
scripts/              deploy, verify, gas-benchmark, gas-report, demo-local, serve-frontend
test/                 тести Mocha/Chai
frontend/             вебінтерфейс
deployments/          адреси розгортань
docs/                 проєктна документація
```
