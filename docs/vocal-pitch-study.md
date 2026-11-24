# 選択ボーカルの音程検出とフレーズ補正（#102）

本体には音程表示を採用する。FXパネルで選択トラックとルーラー範囲の重なる部分を解析し、各時刻のHz・音名と、指定した目標音からのセント差を読める。解析は端末内のWorkerで、最大8秒。無声・低信頼のフレームは空欄にする。解析も補正実験も原音やプロジェクトを変更しない。

補正は開発用試聴ページに留める。単音に限れば指定音へのずれは減った。音の並びを自動決定する仕組みは入れていない。数値上の改善だけでは子音・しゃくり・ビブラートの自然さを判定できず、人による試聴判定は未記録。

## 実測

macOS 15.3.2 arm64、Chrome 158.0.8127.37、48 kHz。Worker時間には前後のF0解析、WASMの読み込み・コンパイル、補正、境界のクロスフェードを含む。各条件1回の実測。

| 素材・指定した目標 | 補正前の中央値 | 補正後の中央値 | Worker時間 | 入出力フレーム数 |
| --- | ---: | ---: | ---: | ---: |
| 合成音 −32 cent、±20 cent / 5 Hzのビブラート、A3 | −32.6 cent | −16.4 cent | 150 ms | 48,000 |
| 合成音 +32 cent、同じビブラート、A3 | +31.3 cent | +15.8 cent | 124 ms | 48,000 |
| vocadito_1、0.66–0.95秒、D3 | −38.4 cent | −21.2 cent | 355 ms | 13,920 |
| vocadito_1、1.32–2.16秒、F3 | +3.2 cent | +1.8 cent | 121 ms | 40,320 |

合成音の瞬時F0の絶対誤差は中央の有声区間で中央値2.1 / 2.4 cent、最大4.2 / 4.0 cent。無音前後での誤検出は両方0フレーム。別途ユニットテストにシードを固定したノイズを含めた。実歌声の数値は同じ検出器による前後比較で、聴感評価ではない。

## 再現と試聴

1. `pnpm install --frozen-lockfile`、`pnpm dev`。表示されたローカルURLに `/scripts/pitch-study.html` を付けて開く。
2. 単独歌声のWAVを選び、単音の開始秒・終了秒・目標MIDI音高を指定する。表の実歌声はMIDI 50と53。「試聴音源を作る」で原音と補正音を切り替えられる。
3. 比較には同じ前後各0.45秒を含める。選択範囲内は目標に近い有声部分だけを最大25 cent動かす。境界を12 msかけて混ぜ、選択範囲外のPCMを維持してから、試聴専用のゲインで両方のRMSを揃える。歌い出しの子音、母音へ滑り込む位置、持続音の周期的な揺れを比較する。ページを閉じると試聴データは破棄される。

検証音源は Rachel Bittner、Katherine Pasalo、Juan José Bosch、Gabriel Meseguer Brocal、David Rubinstein による *vocadito* v3（CC BY 4.0）の `Audio/vocadito_1.wav`。上記範囲を抜粋し、補正版をローカルで生成した。音源をリポジトリには含めていない。[データセット](https://zenodo.org/records/5578807)・[ライセンス](https://creativecommons.org/licenses/by/4.0/)

音程検出は新規実装。補正実験は既存の `rubberband-wasm@3.3.0` を再利用する。Rubber Band本体はGPL v2 or later、ラッパーのパッケージ表記はGPLv2。新しい依存追加や第三者実装の移植はない。[Rubber Bandのライセンス](https://breakfastquay.com/rubberband/license.html)・[WASMラッパー](https://github.com/Daninet/rubberband-wasm)
