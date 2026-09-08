# TronKeeper - Product Requirements Document

## Project Overview
TronKeeper es una crypto wallet / mini app para Telegram enfocada en engagement y rewards. El producto es custodial (wallet central + MEMO único por usuario).

**Fecha de inicio:** Abril 2026
**Estado:** MVP Completado

---

## Core Value Proposition
1. **Hold to Earn** - Mantener presionado un botón para ganar USDT rewards
2. **Sistema de Referidos** - Pool limitado de 50,000 TRX para incentivar crecimiento
3. **Wallet Custodial** - Deposit/Withdraw/Transactions con MEMO único

---

## User Personas

### Usuario Principal
- Usuario de Telegram interesado en crypto
- Busca formas de ganar rewards sin inversión inicial
- Valora la simplicidad y claridad en wallets
- Quiere compartir y ganar por referidos

---

## Technical Architecture

### Frontend (React)
```
/app/frontend/src/
├── components/
│   ├── layout/ (BottomNav, Header, PageContainer)
│   ├── wallet/ (BalanceCard, DepositInfo, WithdrawModal)
│   ├── earn/ (HoldButton, HoldSection)
│   ├── transactions/ (TransactionList, TransactionItem)
│   ├── referrals/ (ReferralCard)
│   ├── missions/ (MissionsList)
│   └── shared/ (CopyButton, LoadingState, EmptyState)
├── contexts/ (WalletContext)
├── services/ (api.js - adapter para backend)
├── hooks/ (useCopyToClipboard, useTelegram)
├── trade/ (TradePanel, CandleChart, OrderForm, PositionsList)
└── pages/ (Home, Trade, Wallet [Balance + Activity], Missions, Referrals)
```

### Backend Integration
- Worker URL: `https://shiny-surf-110c.tkexchange.workers.dev`
- Endpoints: `/auth`, `/claim`
- MEMO único por usuario para depósitos

### Design System
- Dark theme obligatorio
- Tipografía: Unbounded (headings) + Manrope (body)
- Colores: brand-green (#00E676), brand-red (#FF2A3A)
- Mobile-first para Telegram Mini App

---

## Features Implemented ✅

### Home Page
- [x] Header con avatar, username y balance
- [x] Quick actions: Deposit, Withdraw
- [x] Hold to Earn section con botón interactivo
- [x] Stats: Rewards count, Invites count
- [x] Remaining holds indicator (3 por ciclo de 6h)
- [x] Recent activity feed

### Hold to Earn
- [x] Botón hold con imagen Tether personalizada
- [x] Progress ring animation durante hold
- [x] Feedback táctil (Telegram haptic)
- [x] Prize animation al completar
- [x] Límite de 3 holds por ciclo de 6 horas
- [x] Integración con backend /claim

### Trade Panel (v2.3)
- [x] Chart de velas SVG propio (5 pares, 4 timeframes, crosshair táctil)
- [x] Datos reales de Binance con fallback sintético determinístico
- [x] Compra con el saldo interno de USDT (fee 0.1% por lado)
- [x] Posiciones abiertas con PnL en vivo y cierre en 2 taps
- [x] PnL realizado + ledger `trade_buy` / `trade_sell` en History
- [x] Endpoints `/trade`, `/trade/close`, `/positions` + RPC `open_trade`/`close_trade`
- [x] Pestaña propia en el medio de la barra inferior (Home · Missions · Trade · Invite · Wallet)

### Wallet Page
- [x] Total balance hero
- [x] Balance cards por asset (USDT, TRX)
- [x] Deposit info con address + MEMO copiables
- [x] Warning de red TRC-20
- [x] Toggle para mostrar/ocultar deposit info

### Withdraw Flow (UI Ready - Backend Pending)
- [x] Step 1: Selección de asset
- [x] Step 2: Amount + Address input con validación
- [x] Step 3: Confirmación con resumen
- [x] Step 4: Estado de éxito
- [x] Validación de dirección TRON
- [x] Nota sobre backend validation pending

### Transactions / History
- [x] Lista de transacciones con iconos por tipo
- [x] Filtros: All, Deposits, Withdrawals, Rewards
- [x] Estados: confirmed, pending, failed
- [x] Mock data preparado para backend real

### Referrals
- [x] Pool status bar con urgencia visual
- [x] Stats: Friends invited, TRX earned
- [x] Referral link copiable
- [x] Share button con Telegram integration
- [x] How it works section

### Missions
- [x] Mission cards con progreso
- [x] Tipos: daily, weekly, milestone, one-time
- [x] Rewards display
- [x] Claim buttons (pending backend)

---

## Mocked / Pending Backend

| Feature | Status | Notes |
|---------|--------|-------|
| Transaction history endpoint | MOCKED | UI ready, needs `/transactions` endpoint |
| Referral pool stats | MOCKED | UI ready, needs pool stats endpoint |
| Withdraw processing | MOCKED | UI complete, needs backend validation |
| Mission claims | MOCKED | UI ready, needs claim endpoints |
| Real-time balance updates | Partial | Uses /auth response |

---

## P0 - Critical (Done)
- [x] Home con Hold to Earn funcional
- [x] Navigation entre todas las pantallas
- [x] Wallet con deposit info clara
- [x] Withdraw UI completa

## P1 - Important (Next Phase)
- [ ] Backend endpoint para transactions
- [ ] Backend endpoint para pool stats real
- [ ] Backend validation para withdrawals
- [ ] Push notifications para deposits

## P2 - Nice to Have
- [ ] Animations más elaboradas en prize
- [ ] Sonidos de feedback
- [ ] Leaderboard de referidos
- [ ] Achievement badges

---

## Next Action Items
1. Conectar endpoint real de transactions cuando esté disponible
2. Implementar backend validation para withdrawals
3. Añadir endpoint de pool stats real
4. Considerar leaderboard de referidos para engagement

---

## Technical Notes

### Deposit Flow
- Address: `TNjqVzo47ndAvH241njkMLKbda3G6FPgVs` (central wallet)
- MEMO: User's UID (único por usuario)
- Network: TRON TRC-20 only

### Hold to Earn Mechanics
- Duration: 3 seconds
- Prize range: $0.02 - $0.08 USDT
- Max holds: 3 per 6-hour cycle
- Reset timer visible cuando se agotan

### API Adapter Pattern
El archivo `/app/frontend/src/services/api.js` actúa como adapter entre el frontend y el backend worker. Facilita:
- Cambiar endpoints sin tocar componentes
- Mock data para desarrollo
- Fallback cuando backend no responde
