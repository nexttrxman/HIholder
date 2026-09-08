/**
 * Iconos de activo, con los paths oficiales de cada marca.
 *
 * Son componentes SVG inline en vez de <img src="data:...">: no hacen una
 * petición, se ven nítidos a cualquier tamaño y heredan currentColor si hace
 * falta. Los viewBox son los nativos de cada logo, así que la geometría queda
 * exactamente como el original (el de Tether no es cuadrado: 339.43 x 295.27;
 * preserveAspectRatio por defecto lo centra sin deformarlo).
 */

/** Tether (USDT) — marca angular verde con el símbolo ₮. */
export function UsdtIcon({ className = 'w-6 h-6', ...props }) {
  return (
    <svg
      viewBox="0 0 339.43 295.27"
      className={className}
      role="img"
      aria-label="USDT"
      {...props}
    >
      <path
        fillRule="evenodd"
        fill="#50af95"
        d="m62.15 1.45-61.89 130a2.52 2.52 0 0 0 .54 2.94l167.15 160.17a2.55 2.55 0 0 0 3.53 0L338.63 134.4a2.52 2.52 0 0 0 .54-2.94l-61.89-130A2.5 2.5 0 0 0 275 0H64.45a2.5 2.5 0 0 0-2.3 1.45Z"
      />
      <path
        fillRule="evenodd"
        fill="#fff"
        d="M191.19 144.8c-1.2.09-7.4.46-21.23.46-11 0-18.81-.33-21.55-.46-42.51-1.87-74.24-9.27-74.24-18.13s31.73-16.25 74.24-18.15v28.91c2.78.2 10.74.67 21.74.67 13.2 0 19.81-.55 21-.66v-28.9c42.42 1.89 74.08 9.29 74.08 18.13s-31.65 16.24-74.08 18.12Zm0-39.25V79.68h59.2V40.23H89.21v39.45h59.19v25.86c-48.11 2.21-84.29 11.74-84.29 23.16s36.18 20.94 84.29 23.16v82.9h42.78v-82.93c48-2.21 84.12-11.73 84.12-23.14s-36.09-20.93-84.12-23.15Zm0 0Z"
      />
    </svg>
  );
}

/** TRON (TRX) — disco rojo con la marca blanca. */
export function TrxIcon({ className = 'w-6 h-6', ...props }) {
  return (
    <svg
      viewBox="0 0 201 193"
      className={className}
      role="img"
      aria-label="TRX"
      {...props}
    >
      <path
        fill="#FF060A"
        d="M100.8 192.148C156.049 192.148 200.8 149.236 200.8 96.3238C200.8 43.4119 156.049 0.5 100.8 0.5C45.551 0.5 0.800003 43.4119 0.800003 96.3238C0.800003 149.236 45.5893 192.148 100.8 192.148Z"
      />
      <path
        fill="#fff"
        d="M157.045 79.1207C151.528 74.2165 143.865 66.7452 137.658 61.4579L137.275 61.228C136.662 60.7682 135.972 60.3851 135.244 60.1169C120.225 57.4349 50.3402 44.9061 48.9992 45.0594C48.6161 45.0977 48.2329 45.251 47.9264 45.4425L47.5816 45.7107C47.1602 46.1322 46.8153 46.6303 46.6238 47.205L46.5471 47.4349V48.6992V48.8908C54.4015 69.887 85.4743 138.623 91.6046 154.791C91.9877 155.902 92.6774 157.971 93.9801 158.086H94.2866C94.9762 158.086 97.9648 154.293 97.9648 154.293C97.9648 154.293 151.336 92.3008 156.739 85.7107C157.428 84.9061 158.041 84.0249 158.578 83.1054C158.731 82.3774 158.654 81.6494 158.386 80.9598C158.118 80.2701 157.62 79.6188 157.045 79.1207ZM111.605 86.3621L134.363 68.2778L147.735 80.0786L111.605 86.3621ZM102.754 85.1743L63.5586 54.3697L127.007 65.5958L102.754 85.1743ZM106.279 93.2203L146.394 87.0134L100.532 140.002L106.279 93.2203ZM58.233 57.4732L99.4973 90.9981L93.5203 140.04L58.233 57.4732Z"
      />
    </svg>
  );
}

export const ASSET_ICONS = {
  USDT: UsdtIcon,
  TRX: TrxIcon,
};

export default ASSET_ICONS;
