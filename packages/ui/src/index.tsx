import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { CacheProvider } from '@emotion/react';
import createCache from '@emotion/cache';
import { prefixer } from 'stylis';
import rtlPlugin from '@mui/stylis-plugin-rtl';
import { createTheme, ThemeProvider, CssBaseline } from '@mui/material';

export function HotelTheme({
  direction,
  children,
}: {
  direction: 'rtl' | 'ltr';
  children: ReactNode;
}) {
  const cache = useMemo(
    () =>
      createCache({
        key: direction === 'rtl' ? 'hotel-rtl' : 'hotel',
        stylisPlugins: direction === 'rtl' ? [prefixer, rtlPlugin] : [prefixer],
      }),
    [direction],
  );
  const theme = useMemo(
    () =>
      createTheme({
        direction,
        palette: {
          primary: {
            main: '#182c3a',
            light: '#e9eef0',
            dark: '#10212d',
            contrastText: '#ffffff',
          },
          secondary: { main: '#76562d', dark: '#5d421f' },
          background: { default: '#f6f3ed', paper: '#ffffff' },
          text: { primary: '#182c3a', secondary: '#52616b' },
          divider: '#d8d2c8',
          success: { main: '#246447' },
          warning: { main: '#7a5100' },
          error: { main: '#a12b34' },
        },
        shape: { borderRadius: 8 },
        typography: {
          fontFamily: 'Tahoma, Arial, sans-serif',
          allVariants: { letterSpacing: 0 },
          h1: { fontSize: 28, lineHeight: 1.35, fontWeight: 700 },
          h2: { fontSize: 22, lineHeight: 1.4, fontWeight: 700 },
          h3: { fontSize: 18, lineHeight: 1.5, fontWeight: 700 },
          body1: { fontSize: 15, lineHeight: 1.65 },
          body2: { fontSize: 13, lineHeight: 1.65 },
          button: { textTransform: 'none', fontWeight: 700 },
        },
        components: {
          MuiCssBaseline: {
            styleOverrides: {
              body: { fontVariantNumeric: 'tabular-nums' },
            },
          },
          MuiButtonBase: {
            styleOverrides: {
              root: {
                '&.Mui-focusVisible': {
                  outline: '3px solid #76562d',
                  outlineOffset: 3,
                },
              },
            },
          },
          MuiButton: {
            defaultProps: { disableElevation: true },
            styleOverrides: {
              root: { minHeight: 40, borderRadius: 7, paddingInline: 16 },
              sizeSmall: { minHeight: 36 },
            },
          },
          MuiOutlinedInput: {
            styleOverrides: {
              root: {
                backgroundColor: '#fff',
                '& .MuiOutlinedInput-notchedOutline': {
                  borderColor: '#8a959b',
                },
              },
            },
          },
          MuiPaper: {
            styleOverrides: {
              outlined: { borderColor: '#d8d2c8' },
            },
          },
          MuiTableCell: {
            styleOverrides: {
              head: {
                backgroundColor: '#f0ede6',
                color: '#182c3a',
                fontWeight: 700,
                whiteSpace: 'nowrap',
              },
              root: { borderBottomColor: '#e5e0d8' },
              sizeSmall: { height: 48, padding: '10px 16px' },
            },
          },
          MuiTabs: {
            styleOverrides: {
              root: { minHeight: 46, borderBottom: '1px solid #d8d2c8' },
              indicator: { height: 3, backgroundColor: '#76562d' },
            },
          },
          MuiTab: {
            styleOverrides: {
              root: { minHeight: 46, fontWeight: 700, textTransform: 'none' },
            },
          },
          MuiDialogTitle: {
            styleOverrides: { root: { borderBottom: '1px solid #e5e0d8' } },
          },
          MuiDialogActions: {
            styleOverrides: { root: { padding: '16px 24px' } },
          },
        },
      }),
    [direction],
  );
  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
