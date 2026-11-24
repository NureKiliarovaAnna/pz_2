# Slither

Звіт Slither ще не отримано: у середовищі, де готувався проєкт, встановлення
`slither-analyzer` було заблоковано. Запустіть аналіз локально:

```bash
pip install slither-analyzer solc-select
solc-select install 0.8.28
solc-select use 0.8.28
npm run compile
slither . 2>&1 | tee docs/slither/slither-output.txt
slither . --checklist > docs/slither/slither-checklist.md
```

Конфігурація — у [`slither.config.json`](../../slither.config.json): аналізуються
лише основні контракти; `node_modules`, тестові помічники (`contracts/test`) і
навмисно вразлива навчальна копія (`contracts/security`) виключені. Вразливу
копію можна проаналізувати окремо, щоб показати, що Slither її виявляє:

```bash
slither contracts/security/VulnerableDAOTreasury.sol --solc-remaps "@openzeppelin=node_modules/@openzeppelin"
```

Після запуску кожне зауваження треба або виправити, або пояснити (таблиця
«детектор — місце — рішення — обґрунтування») у звіті.
