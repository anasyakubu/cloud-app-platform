import type {Config} from 'tailwindcss';
export default {content:['./index.html','./src/**/*.{tsx,ts}'],darkMode:'class',theme:{extend:{colors:{ink:'#142126',accent:'#1c7168',muted:'#697980',surface:'#f6f7f5'},fontFamily:{sans:['Inter','ui-sans-serif','system-ui']}}},plugins:[]} satisfies Config;
