Навмисно вразлива навчальна копія (`contracts/security`) виключена. Вразливу
копію можна проаналізувати окремо, щоб показати, що Slither її виявляє:

```bash
slither contracts/security/VulnerableDAOTreasury.sol --solc-remaps "@openzeppelin=node_modules/@openzeppelin"
```