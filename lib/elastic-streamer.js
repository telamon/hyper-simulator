const { Client } = require('@elastic/elasticsearch')
const { BasicTimeline } = require('hypersim-parser')

class ElasticStreamer extends BasicTimeline {
  constructor (url, batchSize = 50) {
    super({})
    this.sessionId = null
    this.client = new Client({ node: url })
    this.on('snapshot', snap => this.index(snap, true))
    this._indexName = null
    this.batchSize = batchSize
    this.batch = []
  }

  createIndex () {
    this._indexName = `hypersim-${this.sessionId}`
    return this.client.indices.create({
      index: this._indexName,
      body: {
        mappings: {
          properties: {
            // id: { type: 'integer' },
            // text: { type: 'text' },
            // user: { type: 'keyword' },
            // time: { type: 'date' }
            sessionId: { type: 'date' },
            time: { type: 'integer' },
            iteration: { type: 'integer' },
            type: { type: 'keyword' }
          }
        }
      }
    }, { ignore: [400] })
  }

  async index (e, isSnap) {
    if (isSnap) return
    if (!this.sessionId) this.sessionId = e.sessionId
    if (!this._indexName) await this.createIndex()
    this.batch.push(e)

    if (this.batch.length > this.batchSize) await this.commitBatch()
  }

  async commitBatch (refresh = false) {
    const body = this.batch.flatMap(doc => [{ index: { _index: this._indexName } }, doc])
    const { body: bulkResponse } = await this.client.bulk({ refresh, body })

    this.batch = []
    if (bulkResponse.errors) {
      const erroredDocuments = []
      // The items array has the same order of the dataset we just indexed.
      // The presence of the `error` key indicates that the operation
      // that we did for the document has failed.
      bulkResponse.items.forEach((action, i) => {
        const operation = Object.keys(action)[0]
        if (action[operation].error) {
          erroredDocuments.push({
            // If the status is 429 it means that you can retry the document,
            // otherwise it's very likely a mapping error, and you should
            // fix the document before to try it again.
            status: action[operation].status,
            error: action[operation].error,
            operation: body[i * 2],
            document: body[i * 2 + 1]
          })
        }
      })
      console.log(erroredDocuments)
    }
  }
}

module.exports = ElasticStreamer
