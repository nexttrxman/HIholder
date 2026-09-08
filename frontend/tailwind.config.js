/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'sans-serif'],
        // Headings use the same clean sans (Manrope) per the TRON-console spec.
        display: ['Manrope', 'sans-serif'],
        // Labels, statuses and small technical text.
        mono: ['"DM Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Remapped globally: every text-white / bg-white in the app becomes the
        // bluish near-white, and every text-black / bg-black the petrol base.
        white: '#e9fffb',
        black: '#06131a',
        app: {
          bg: '#06131a',
          deep: '#041016',
          surface: '#0a1c25',
          glass: 'rgba(233,255,251,0.04)',
        },
        brand: {
          teal: '#57d6c8',
          mint: '#8cf2db',
          blue: '#83a7e9',
          gold: '#ffd166',
          // Aliases kept so existing class names keep working.
          green: '#57d6c8',
          red: '#ff6b7a',
          glow: 'rgba(87,214,200,0.2)',
        },
        ink: {
          DEFAULT: '#e9fffb',
          dim: '#8faeaa',
        },
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        console: '1.75rem',
      },
      boxShadow: {
        // "Space console module": soft inner light + deep outer drop.
        console:
          'inset 0 1px 0 rgba(233,255,251,0.07), inset 0 -24px 48px -32px rgba(87,214,200,0.28), 0 24px 48px -28px rgba(0,0,0,0.85)',
        'console-sm':
          'inset 0 1px 0 rgba(233,255,251,0.05), 0 12px 24px -18px rgba(0,0,0,0.8)',
        'glow-teal': '0 0 24px rgba(87,214,200,0.35), 0 0 60px rgba(87,214,200,0.12)',
        'glow-gold': '0 0 24px rgba(255,209,102,0.35), 0 0 60px rgba(255,209,102,0.12)',
        'glow-blue': '0 0 24px rgba(131,167,233,0.35), 0 0 60px rgba(131,167,233,0.12)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.05)' },
        },
        'progress-fill': {
          '0%': { strokeDashoffset: '565.49' },
          '100%': { strokeDashoffset: '0' },
        },
        'orb-drift': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)', opacity: '0.55' },
          '50%': { transform: 'translate3d(0,-18px,0) scale(1.08)', opacity: '0.8' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'orb-drift': 'orb-drift 14s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
    }
  },
  plugins: [require("tailwindcss-animate")],
};
