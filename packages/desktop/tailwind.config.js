/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#141414",
        border: "#2A2A2A",
      },
    },
  },
  plugins: [],
};
