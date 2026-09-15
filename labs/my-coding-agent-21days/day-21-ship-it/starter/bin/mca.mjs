/**
 * 全局命令的入口。本天新增。
 *
 * TODO(1) 这个文件与 package.json 里的 bin / files 两个字段一起，决定了「装完之后
 *   敲 mca 会发生什么」。现在有两处不对，自检的第 2、3 项会告诉你是哪两处：
 *     a. 这个文件少了第一行（提示：类 Unix 上执行它的是 shell，不是 node）
 *     b. package.json 的 files 是逐个文件列的——想想这门课后面还会往 src 下加多少东西
 *
 * 三件事，每件都有一个踩过才记得住的理由：
 *
 * ① **第一行必须是 shebang。** npm 在类 Unix 上给 bin 建的是符号链接，
 *    执行它的是 shell 而不是 node；没有这一行，shell 会拿它当 sh 脚本读，
 *    报的是 `syntax error near unexpected token` 这种完全指不到病根的错。
 *
 * ② **它是 .mjs 而不是 .js。** 这个入口是从 dist 之外被执行的，
 *    扩展名是 Node 判断模块类型的第一依据；写成 .js 就得指望 package.json
 *    的 type 字段一直是 module，那是一个不必要的耦合。
 *
 * ③ **它只有一行 import，不写任何业务。** bin 是发布契约的一部分，
 *    路径一旦公开就不好改；把逻辑留在 dist 里，这个文件可以一辈子不动。
 */
import '../dist/index.js'
