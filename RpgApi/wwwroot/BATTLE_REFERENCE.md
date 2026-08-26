# Combat System Specification

## Attributes Overview

| Attribute | Category | Core Mechanics & Primary Role |
| :--- | :--- | :--- |
| **HP (Hit Points)** | Health | Total damage capacity. Reduced by incoming attacks. Reaching 0 HP results in defeat. |
| **Base DMG (Base Damage)** | Base Offense | Starts at **10**. Each level-up yields a **chance for +1** (~14–18 BD by Level 20). Serves as the base value multiplied by attribute ratios. |
| **ATT (Attack)** | Offense | Increases damage linear scaling relative to enemy **DEF** (+5% per advantage point). |
| **DEF (Defense)** | Defense | Directly counters enemy **ATT**, suppressing their stat multiplier (-2.5% per advantage point). |
| **ARM (Armor)** | Defense | Provides flat percentage mitigation (5% per point, capped at **75%**). Directly countered by **AGI**. |
| **AGI (Agility)** | Offense | Functions as Armor Penetration. Bypasses enemy **ARM** on a 1:1 basis before mitigation is applied. |

---

## Damage Formula

The system uses a hard minimum floor of **1 HP** so no successful hit is fully negated.

$$\text{Final Damage} = \max\left(1, \, \left\lfloor \text{Base DMG} \times \text{Stat Multiplier} \times (1 - \text{Armor Reduction}) \right\rfloor\right)$$

### 1. Stat Multiplier ($\text{ATT} \text{ vs. } \text{DEF}$)

Let $\Delta = \text{ATT}_\text{Attacker} - \text{DEF}_\text{Defender}$:

* **Attacker Advantage ($\Delta \ge 0$):**
  $$\text{Stat Multiplier} = 1 + (0.05 \times \Delta)$$

* **Defender Advantage ($\Delta < 0$):**
  $$\text{Stat Multiplier} = \max\left(0.30, \, 1 - (0.025 \times |\Delta|)\right)$$

### 2. Net Armor & Mitigation ($\text{AGI} \text{ vs. } \text{ARM}$)

Calculated by stripping enemy **ARM** down with **AGI** before converting the remaining armor into percentage reduction:

$$\text{Net ARM} = \max\left(0, \, \text{ARM}_\text{Defender} - \text{AGI}_\text{Attacker}\right)$$

$$\text{Armor Reduction} = \min\left(0.75, \, \text{Net ARM} \times 0.05\right)$$

---

## Balancing & Scaling Assumptions

* **Battle Pacing:** Enemy HP scales proportionally to keep standard encounters lasting **2–4 hits**.
* **HP Inflation Control:** Because **Base DMG** remains low (10–18), HP pools stay under **100 HP** all the way through Level 20.
* **Counter Matrix:**
  * **ATT** $\leftrightarrow$ **DEF** *(Linear Multiplier Scaling)*
  * **AGI** $\leftrightarrow$ **ARM** *(Percentage Mitigation & Penetration)*