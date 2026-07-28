// 획득한 리소스를 정리한다.
class ResourceScope {
  constructor() {
    this.disposers = [];
  }

  register(name, dispose) {
    this.disposers.push({ name, dispose });
  }

  disposeAll() {
    for (const { dispose } of this.disposers) {
      dispose();
    }
    this.disposers = [];
  }
}
module.exports = { ResourceScope };
