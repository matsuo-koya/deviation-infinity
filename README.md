# DEVIATION∞ / 偏差機関

> 予測と偏差の無限音楽装置 — TECHNO / MINIMAL / EDM

React + [Tone.js](https://tonejs.github.io/) で書かれた、単一コンポーネントのジェネラティブ音楽エンジンです。

## 設計思想

反復は聴き手の予測モデルを安定させる (familiarity ↑)。安定した予測の上でだけ、微小なズレが予測誤差として際立ちます。本機は「聴取シミュレータ」を内蔵し、慣れが飽和したら偏差を注入し、驚きが過剰なら反復に戻ります。[Wundt曲線](https://en.wikipedia.org/wiki/Wilhelm_Wundt)の甘い帯域に予測誤差を保ち続けることで、無限に演奏し続けます。

## 使い方

`DeviationEngine.jsx` は単一の React コンポーネントです。React プロジェクトに取り込み、`tone` を依存に追加してください。

```bash
npm install tone
```

```jsx
import DeviationEngine from "./DeviationEngine";

export default function App() {
  return <DeviationEngine />;
}
```

ブラウザの音声再生はユーザー操作を必要とするため、再生ボタンを押してから音が鳴ります。

## 依存

- React
- [Tone.js](https://www.npmjs.com/package/tone)

## License

MIT
