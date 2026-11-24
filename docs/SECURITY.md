# Атака на власний контракт: пропущена перевірка ролі

## Вразливий код

[`contracts/security/VulnerableDAOTreasury.sol`](../contracts/security/VulnerableDAOTreasury.sol) — точна копія `DAOTreasury`, у якій у `reservePayout` прибрано модифікатор `onlyGovernor`:

```solidity
// DAOTreasury (правильно)
) external override onlyGovernor whenNotPaused {

// VulnerableDAOTreasury (навмисна вразливість)
) external override whenNotPaused {
```

Решта перевірок (нульовий отримувач, нульова сума, повторний `proposalId`, нестача вільних коштів, пауза) збережена; це підтверджують ті самі тести граничних випадків, запущені на обох скарбницях.

## Атакувальник

[`contracts/security/PayoutAttacker.sol`](../contracts/security/PayoutAttacker.sol):

```solidity
function attack(uint256 proposalId, uint256 amount) external {
    target.reservePayout(proposalId, address(this), amount); // без голосування
    target.withdraw();                                        // забирає кошти
}
receive() external payable {}
```

## Хід атаки

1. Розгорнуто справжню систему: `DAOToken`, скарбницю, `DAOGovernor`; `setGovernor(governor)`; у скарбниці 1 ETH.
2. Сторонній акаунт без жодних ролей розгортає `PayoutAttacker` і викликає `attack(999, 1 ETH)`. Пропозиції 999 не існує, голосування не було.
3. Вразлива скарбниця не перевіряє, хто викликає `reservePayout`, і записує `claimable[attacker] = 1 ETH`.
4. `withdraw()` чесно виплачує «зарезервовані» кошти.

## Результати тестів ([`test/Security.test.js`](../test/Security.test.js))

| Тест | Скарбниця до → після | Атакувальник до → після | Результат |
|---|---|---|---|
| A — `VulnerableDAOTreasury` | 1.0 → 0.0 ETH | 0.0 → 1.0 ETH | атака вдалася; `proposalCount = 0`, `claimable` і `totalReserved` = 0 |
| B — `DAOTreasury` | 1.0 → 1.0 ETH | 0.0 → 0.0 ETH | відхилено `UnauthorizedGovernor(<адреса атакувальника>)`; облік не змінено |

Запуск: `npm run test:security`.

## Виправлення

Модифікатор `onlyGovernor` дозволяє резервувати кошти лише контракту голосування. Адресу Governor адміністратор задає один раз (`setGovernor`), і це має бути контракт; `DAOGovernor.execute` викликає `reservePayout` лише для пропозиції у стані `Succeeded`. Отже, кошти рухаються тільки після голосування з кворумом.

## Додатковий захист від повторного входу

`withdraw` дотримується порядку «перевірки → зміна стану → зовнішній виклик»: `claimable` обнуляється до `call{value}`. Якби кроки поміняти місцями, контракт-отримувач міг би з `receive()` знову викликати `withdraw` і отримати ту саму суму кілька разів. Додатково стоїть `nonReentrant`.
