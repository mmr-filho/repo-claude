// A ordem importa: o polyfill de aleatoriedade precisa existir antes de qualquer código de criptografia.
import './src/polyfills';
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
